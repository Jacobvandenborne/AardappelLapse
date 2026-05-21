import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, Modal, TextInput } from 'react-native';
import { supabase, fetchAllPhotoLocations, fetchParcels, fetchCroppingYears, insertParcels, insertCroppingYear, GOOGLE_DRIVE_FOLDERS } from '../lib/supabase';
import { GoogleDrive } from '../lib/googleDrive';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import JSZip from 'jszip';
import parseShp from 'shpjs/lib/parseShp.js';
import parseDbf from 'parsedbf';
import proj4 from 'proj4';
import { Buffer } from 'buffer';
global.Buffer = Buffer;

// Helper to combine SHP and DBF into GeoJSON
const combine = ([shp, dbf]) => {
    return {
        type: 'FeatureCollection',
        features: shp.map((geometry, i) => ({
            type: 'Feature',
            geometry,
            properties: dbf ? (dbf[i] || {}) : {}
        }))
    };
};

export default function ManagementScreen() {
    const [photos, setPhotos] = useState([]);
    const [years, setYears] = useState([]);
    const [selectedYear, setSelectedYear] = useState(null);
    const [parcels, setParcels] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [uploadingParcels, setUploadingParcels] = useState(false);
    const [showYearModal, setShowYearModal] = useState(false);
    const [newYearInput, setNewYearInput] = useState(new Date().getFullYear().toString());
    const [isCreatingYear, setIsCreatingYear] = useState(false);
    const [showDrivePicker, setShowDrivePicker] = useState(false);
    const [driveFiles, setDriveFiles] = useState([]);
    const [loadingDrive, setLoadingDrive] = useState(false);
    const [isProcessingDriveFile, setIsProcessingDriveFile] = useState(false);
    const [currentFolderId, setCurrentFolderId] = useState('root');
    const [navHistory, setNavHistory] = useState([]); // Stack of folder IDs for "Back" button
    const [fullscreenPhoto, setFullscreenPhoto] = useState(null);
    const [userEmail, setUserEmail] = useState('');
    const [isSyncingDrive, setIsSyncingDrive] = useState(false);
    const [syncProgress, setSyncProgress] = useState(0);

    const loadInitialData = async (targetYear = null) => {
        setLoading(true);
        try {
            const fetchedYears = await fetchCroppingYears();
            setYears(fetchedYears);
            if (fetchedYears.length > 0) {
                const activeYear = targetYear
                    ? fetchedYears.find(y => y.year === parseInt(targetYear))
                    : (fetchedYears.find(y => y.is_active) || fetchedYears[0]);

                setSelectedYear(activeYear ? activeYear.year : fetchedYears[0].year);
                await Promise.all([
                    fetchMyPhotos(),
                    loadParcels(activeYear ? activeYear.year : fetchedYears[0].year)
                ]);
            } else {
                await fetchMyPhotos();
            }
        } catch (e) {
            console.error("Error loading initial management data:", e);
        } finally {
            setLoading(false);
        }
    };

    const loadParcels = async (year) => {
        const fetchedParcels = await fetchParcels(year);
        setParcels(fetchedParcels);
    };

    const fetchMyPhotos = async () => {
        setLoading(true);
        try {
            console.log("[Management] Fetching user...");
            const { data: { user } } = await Promise.race([
                supabase.auth.getUser(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("User fetch timed out")), 5000))
            ]);
            if (!user) {
                console.log("[Management] No user found");
                return;
            }
            setUserEmail(user.email);

            const { data, error } = await supabase
                .from('photos')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setPhotos(data || []);
        } catch (error) {
            Alert.alert('Fout', error.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        loadInitialData();
    }, []);

    const handleYearChange = (year) => {
        setSelectedYear(year);
        loadParcels(year);
    };

    const handleAddYear = async () => {
        const yearInt = parseInt(newYearInput);
        if (isNaN(yearInt) || yearInt < 2000 || yearInt > 2100) {
            Alert.alert("Fout", "Voer een geldig jaartal in.");
            return;
        }

        if (years.some(y => y.year === yearInt)) {
            Alert.alert("Fout", "Dit jaar bestaat al.");
            return;
        }

        setIsCreatingYear(true);
        try {
            await insertCroppingYear(yearInt);
            await loadInitialData(yearInt);
            setShowYearModal(false);
            Alert.alert("Succes", `Teeltjaar ${yearInt} is aangemaakt.`);
        } catch (e) {
            Alert.alert("Fout", "Kon jaar niet aanmaken: " + e.message);
        } finally {
            setIsCreatingYear(false);
        }
    };

    const handleUploadShapefile = async () => {
        if (!selectedYear) {
            Alert.alert("Fout", "Selecteer eerst een teeltjaar.");
            return;
        }

        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: 'application/zip',
                copyToCacheDirectory: true,
            });

            if (result.canceled) return;
            setUploadingParcels(true);

            const asset = result.assets[0];
            const base64 = await FileSystem.readAsStringAsync(asset.uri, {
                encoding: 'base64',
            });

            // Convert base64 to Buffer for JSZip compatibility and decoding
            const buffer = Buffer.from(base64, 'base64');
            const allParcels = await processZipContent(buffer);

            if (allParcels.length === 0) {
                throw new Error("Geen geldige percelen gevonden.");
            }

            await insertParcels(allParcels);
            await loadParcels(selectedYear);
            Alert.alert("Succes", `${allParcels.length} percelen toegevoegd aan ${selectedYear}.`);
        } catch (error) {
            console.error("Shapefile Upload Error:", error);
            Alert.alert("Fout", "Kon shapefile niet verwerken: " + error.message);
        } finally {
            setUploadingParcels(false);
        }
    };

    const processZipContent = async (zipData) => {
        // works with ArrayBuffer, Uint8Array or Buffer
        const zip = await JSZip.loadAsync(zipData);
        const files = {};
        const promises = [];

        zip.forEach((relativePath, file) => {
            if (file.dir) return;
            const ext = relativePath.split('.').pop().toLowerCase();
            if (['shp', 'dbf', 'prj', 'cpg'].includes(ext)) {
                promises.push(
                    file.async('uint8array').then(data => {
                        files[relativePath.toLowerCase()] = data;
                    })
                );
            }
        });

        await Promise.all(promises);

        const shpFiles = Object.keys(files).filter(f => f.endsWith('.shp'));
        if (shpFiles.length === 0) {
            throw new Error("Geen .shp bestanden gevonden in de ZIP.");
        }

        const allParcels = [];
        for (const shpFile of shpFiles) {
            const layerName = shpFile.slice(0, -4);
            const dbfFile = layerName + '.dbf';
            const prjFile = layerName + '.prj';
            const cpgFile = layerName + '.cpg';

            let prj = null;
            if (files[prjFile]) {
                try {
                    // Use Buffer instead of TextDecoder for robustness in React Native
                    const prjText = Buffer.from(files[prjFile]).toString('utf-8');
                    prj = proj4(prjText);
                } catch (e) {
                    console.warn("Could not parse PRJ:", e);
                }
            }

            const shpData = files[shpFile];
            const dbfData = files[dbfFile];
            const cpgData = files[cpgFile] ? Buffer.from(files[cpgFile]).toString('utf-8') : null;

            const shpView = new DataView(shpData.buffer, shpData.byteOffset, shpData.byteLength);
            const parsedShp = parseShp(shpView, prj);

            let parsedDbf = null;
            if (dbfData) {
                const dbfView = new DataView(dbfData.buffer, dbfData.byteOffset, dbfData.byteLength);
                parsedDbf = parseDbf(dbfView, cpgData);
            }

            const featureCollection = combine([parsedShp, parsedDbf]);

            featureCollection.features.forEach(feature => {
                allParcels.push({
                    name: feature.properties.NAME || feature.properties.name || feature.properties.ID || "Onbekend Perceel",
                    geometry: feature,
                    year: selectedYear,
                });
            });
        }
        return allParcels;
    };

    const handleDriveFileSelect = async (file) => {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
            // Navigate into folder
            setNavHistory(prev => [...prev, currentFolderId]);
            setCurrentFolderId(file.id);
            loadDriveFiles(file.id);
            return;
        }

        setIsProcessingDriveFile(true);
        try {
            const arrayBuffer = await GoogleDrive.downloadFile(file.id);
            if (!arrayBuffer) throw new Error("Kon bestand niet downloaden van Drive.");

            const allParcels = await processZipContent(arrayBuffer);

            if (allParcels.length === 0) {
                throw new Error("Geen geldige percelen gevonden in dit bestand.");
            }

            await insertParcels(allParcels);
            await loadParcels(selectedYear);
            setShowDrivePicker(false);
            Alert.alert("Succes", `${allParcels.length} percelen toegevoegd uit ${file.name}.`);
        } catch (error) {
            console.error("Drive File Process Error:", error);
            Alert.alert("Fout", error.message);
        } finally {
            setIsProcessingDriveFile(false);
        }
    };

    const loadDriveFiles = async (folderId) => {
        setLoadingDrive(true);
        try {
            const files = await GoogleDrive.listFiles(folderId);
            setDriveFiles(files);
        } catch (error) {
            Alert.alert("Fout", "Kon bestanden op Google Drive niet ophalen.");
        } finally {
            setLoadingDrive(false);
        }
    };

    const openDrivePicker = async () => {
        setShowDrivePicker(true);
        setCurrentFolderId('root');
        setNavHistory([]);
        loadDriveFiles('root');
    };

    const handleDriveBack = () => {
        if (navHistory.length > 0) {
            const newHistory = [...navHistory];
            const prevFolderId = newHistory.pop();
            setNavHistory(newHistory);
            setCurrentFolderId(prevFolderId);
            loadDriveFiles(prevFolderId);
        }
    };

    const handleDelete = async (photo) => {
        Alert.alert(
            "Foto Verwijderen",
            "Weet je zeker dat je deze foto wilt verwijderen?",
            [
                { text: "Annuleren", style: "cancel" },
                {
                    text: "Verwijder",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            // 1. Delete from Storage
                            const path = photo.image_url.split('/').pop();
                            const { error: storageError } = await supabase.storage
                                .from('photos')
                                .remove([path]);

                            if (storageError) console.log("Storage delete note:", storageError.message);

                            // 2. Delete from DB
                            const { error: dbError } = await supabase
                                .from('photos')
                                .delete()
                                .eq('id', photo.id);

                            if (dbError) throw dbError;

                            setPhotos(prev => prev.filter(p => p.id !== photo.id));
                            Alert.alert("Succes", "Foto is verwijderd.");
                        } catch (error) {
                            Alert.alert("Fout", "Kon foto niet verwijderen: " + error.message);
                        }
                    }
                }
            ]
        );
    };

    const handleSyncAllDrive = async () => {
        const unsynced = photos.filter(p => !p.google_drive_id);
        if (unsynced.length === 0) {
            Alert.alert("Info", "Alle foto's zijn al gesynchroniseerd.");
            return;
        }

        Alert.alert(
            "Sync naar Drive",
            `Er zijn ${unsynced.length} foto's die nog niet in Google Drive staan. Wil je deze nu uploaden?`,
            [
                { text: "Annuleren", style: "cancel" },
                {
                    text: "Start Sync",
                    onPress: async () => {
                        setIsSyncingDrive(true);
                        setSyncProgress(0);
                        const driveFolderId = GOOGLE_DRIVE_FOLDERS[selectedYear] || null;
                        let count = 0;

                        for (const photo of unsynced) {
                            try {
                                // 1. Download photo
                                const resp = await fetch(photo.image_url);
                                const blob = await resp.blob();
                                const base64 = await new Promise((resolve, reject) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                    reader.onerror = reject;
                                    reader.readAsDataURL(blob);
                                });

                                // 2. Upload to Drive
                                const fileName = photo.image_url.split('/').pop();
                                const driveId = await GoogleDrive.uploadFile(fileName, 'image/jpeg', base64, driveFolderId);

                                if (driveId) {
                                    // 3. Update Supabase
                                    await supabase.from('photos').update({ google_drive_id: driveId }).eq('id', photo.id);
                                    count++;
                                }
                            } catch (e) {
                                console.error("[Sync] Error syncing photo:", photo.id, e);
                            }
                            setSyncProgress(++count / unsynced.length);
                        }

                        setIsSyncingDrive(false);
                        fetchMyPhotos(); // Refresh list
                        Alert.alert("Klaar", `${count} foto's zijn succesvol naar Google Drive gekopieerd.`);
                    }
                }
            ]
        );
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    const renderItem = ({ item }) => (
        <View style={styles.photoCard}>
            <TouchableOpacity
                style={styles.thumbContainer}
                onPress={() => setFullscreenPhoto(item.image_url)}
            >
                <Image
                    source={{ uri: item.image_url }}
                    style={styles.photoThumb}
                    contentFit="cover"
                />
            </TouchableOpacity>

            <View style={styles.photoInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={1}>{item.parcel_name || "Onbekend Perceel"}</Text>
                    {item.google_drive_id ? (
                        <Ionicons name="cloud-done" size={16} color="#667B53" style={{ marginLeft: 5 }} />
                    ) : (
                        <Ionicons name="cloud-upload-outline" size={16} color="#D0A367" style={{ marginLeft: 5 }} />
                    )}
                </View>
                <View style={styles.cardSub}>
                    <Ionicons name="calendar-outline" size={10} color="#5E462F" />
                    <Text style={styles.cardDate}>
                        {new Date(item.created_at).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}
                    </Text>
                    <Ionicons name="time-outline" size={10} color="#5E462F" style={{ marginLeft: 8 }} />
                    <Text style={styles.cardTime}>
                        {new Date(item.created_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                </View>

                {/* Weather & Advanced Info (Option 5 & 3) */}
                <View style={[styles.cardSub, { marginTop: 4 }]}>
                    {item.weather_temp !== null && (
                        <>
                            <Ionicons name="thermometer-outline" size={10} color="#667B53" />
                            <Text style={styles.weatherText}>{Math.round(item.weather_temp)}°C</Text>
                        </>
                    )}
                    {item.weather_description && (
                        <Text style={[styles.weatherText, { fontStyle: 'italic', opacity: 0.7 }]}>
                            • {item.weather_description}
                        </Text>
                    )}
                    {item.ndvi_value && (
                        <View style={styles.ndviBadgeSmall}>
                            <Text style={styles.ndviBadgeText}>NDVI: {item.ndvi_value.toFixed(2)}</Text>
                        </View>
                    )}
                </View>
            </View>

            <TouchableOpacity style={styles.deleteBtnCompact} onPress={() => handleDelete(item)}>
                <Ionicons name="trash-outline" size={20} color="#D51317" />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={styles.vdbLabel}>VDBORNE</Text>
                        <View style={{ backgroundColor: '#667B53', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, marginLeft: 8 }}>
                            <Text style={{ fontSize: 7, color: 'white', fontFamily: 'Montserrat-Bold' }}>v1.1.1</Text>
                        </View>
                    </View>
                    <Text style={styles.title}>FIELD JOURNAL</Text>
                </View>
                <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
                    <Ionicons name="log-out-outline" size={20} color="#D51317" />
                </TouchableOpacity>
            </View>

            {loading && !refreshing ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" color="#667B53" />
                    <Text style={styles.loadingText}>Velden inladen...</Text>
                </View>
            ) : (
                <FlatList
                    data={[{ id: 'header' }, ...photos]}
                    keyExtractor={(item) => item.id.toString()}
                    onRefresh={() => { setRefreshing(true); loadInitialData(); }}
                    refreshing={refreshing}
                    contentContainerStyle={styles.list}
                    showsVerticalScrollIndicator={false}
                    renderItem={({ item }) => {
                        if (item.id === 'header') {
                            return (
                                <View style={styles.configCard}>
                                    <View style={styles.yearRow}>
                                        <Text style={styles.configLabel}>TEELTJAAR:</Text>
                                        <View style={styles.yearScroll}>
                                            {years.map(y => (
                                                <TouchableOpacity
                                                    key={y.year}
                                                    style={[styles.yearChip, selectedYear === y.year && styles.yearChipActive]}
                                                    onPress={() => handleYearChange(y.year)}
                                                >
                                                    <Text style={[styles.yearChipText, selectedYear === y.year && styles.yearChipActiveText]}>
                                                        {y.year}
                                                    </Text>
                                                </TouchableOpacity>
                                            ))}
                                            <TouchableOpacity style={styles.addYearSmall} onPress={() => setShowYearModal(true)}>
                                                <Ionicons name="add" size={16} color="#667B53" />
                                            </TouchableOpacity>
                                        </View>
                                    </View>

                                    <View style={styles.cloudInfo}>
                                        <View style={styles.cloudRow}>
                                            <Ionicons name="person-circle-outline" size={14} color="#667B53" />
                                            <Text style={styles.cloudText}>Account: <Text style={{ fontFamily: 'Montserrat-Bold' }}>{userEmail || 'Laden...'}</Text></Text>
                                        </View>
                                        <View style={styles.cloudRow}>
                                            <Ionicons name="folder-open-outline" size={14} color="#667B53" />
                                            <Text style={styles.cloudText} numberOfLines={1}>
                                                Folder ID: <Text style={{ fontFamily: 'Montserrat-Bold', fontSize: 9 }}>{GOOGLE_DRIVE_FOLDERS[selectedYear] || 'Automatisch'}</Text>
                                            </Text>
                                        </View>
                                    </View>

                                    <View style={styles.actionRow}>
                                        <TouchableOpacity style={styles.actionBtn} onPress={handleUploadShapefile}>
                                            <Ionicons name="cloud-upload" size={18} color="white" />
                                            <Text style={styles.actionBtnText}>NIEUWE PERCELEN</Text>
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={[styles.actionBtn, { backgroundColor: '#4285F4' }]}
                                            onPress={handleSyncAllDrive}
                                            disabled={isSyncingDrive}
                                        >
                                            {isSyncingDrive ? (
                                                <ActivityIndicator size="small" color="white" />
                                            ) : (
                                                <Ionicons name="cloud-sync" size={18} color="white" />
                                            )}
                                            <Text style={styles.actionBtnText}>
                                                {isSyncingDrive ? `SYNC ${Math.round(syncProgress * 100)}%` : 'SYNC DRIVE'}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>

                                    {parcels.length > 0 && (
                                        <View style={styles.parcelStat}>
                                            <Text style={styles.parcelStatText}>{parcels.length} percelen actief in {selectedYear}</Text>
                                        </View>
                                    )}
                                </View>
                            );
                        }
                        return renderItem({ item });
                    }}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Ionicons name="camera-outline" size={80} color="#D0A367" style={{ opacity: 0.5 }} />
                            <Text style={styles.emptyText}>Geen foto's gevonden voor dit account.</Text>
                        </View>
                    }
                    ListFooterComponent={
                        <View style={{ padding: 40, alignItems: 'center', opacity: 0.3 }}>
                            <Text style={{ fontFamily: 'Montserrat-SemiBold', fontSize: 10 }}>VERSIE 1.1.1 (21-05-2026)</Text>
                            <Text style={{ fontFamily: 'Montserrat-Regular', fontSize: 8, marginTop: 4 }}>ADVANCED FEATURES: WEER & NDVI</Text>
                        </View>
                    }
                />
            )}

            {/* Modals are handled below (keeping original modal logic) */}
            <Modal visible={showYearModal} transparent animationType="fade" onRequestClose={() => setShowYearModal(false)}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>NIEUW TEELTJAAR</Text>
                        <TextInput
                            style={styles.yearInput}
                            value={newYearInput}
                            onChangeText={setNewYearInput}
                            keyboardType="numeric"
                            placeholder="2026"
                        />
                        <View style={styles.modalButtons}>
                            <TouchableOpacity style={[styles.modalBtn, styles.cancelBtn]} onPress={() => setShowYearModal(false)}>
                                <Text style={styles.cancelBtnText}>ANNULEREN</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.modalBtn, styles.confirmBtn]} onPress={handleAddYear} disabled={isCreatingYear}>
                                {isCreatingYear ? <ActivityIndicator color="white" /> : <Text style={styles.confirmBtnText}>OPSLAAN</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            <Modal visible={!!fullscreenPhoto} transparent animationType="fade" onRequestClose={() => setFullscreenPhoto(null)}>
                <View style={styles.fullscreenOverlay}>
                    <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenPhoto(null)}>
                        <Ionicons name="close-circle" size={44} color="white" />
                    </TouchableOpacity>
                    {fullscreenPhoto && (
                        <Image source={{ uri: fullscreenPhoto }} style={styles.fullscreenImage} contentFit="contain" />
                    )}
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7EEE3' },
    header: {
        paddingTop: 65,
        paddingHorizontal: 25,
        paddingBottom: 20,
        backgroundColor: '#FFFFFF',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(102, 123, 83, 0.2)',
    },
    vdbLabel: {
        fontSize: 10,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 2.5,
        color: '#667B53',
        marginBottom: 2
    },
    title: {
        fontSize: 18,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 1,
        color: '#000000'
    },
    logoutBtn: {
        padding: 8,
        borderRadius: 10,
        backgroundColor: 'rgba(213, 19, 23, 0.05)',
    },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    list: { padding: 20 },

    // Management Config Card
    configCard: {
        backgroundColor: 'white',
        borderRadius: 20,
        padding: 20,
        marginBottom: 25,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
    },
    configLabel: {
        fontSize: 11,
        fontFamily: 'Montserrat-Bold',
        color: '#5E462F',
        marginRight: 10
    },
    yearRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 15
    },
    yearScroll: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    yearChip: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: '#F7EEE3',
        marginRight: 8,
        borderWidth: 1,
        borderColor: '#B7D098'
    },
    yearChipActive: {
        backgroundColor: '#667B53',
        borderColor: '#667B53'
    },
    yearChipText: {
        fontFamily: 'Montserrat-Bold',
        fontSize: 12,
        color: '#667B53'
    },
    yearChipActiveText: {
        color: 'white'
    },
    addYearSmall: {
        width: 28, height: 28,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#667B53',
        borderStyle: 'dashed',
        justifyContent: 'center', alignItems: 'center'
    },
    actionRow: {
        flexDirection: 'row',
        gap: 10
    },
    actionBtn: {
        flex: 2,
        backgroundColor: '#3C493A',
        flexDirection: 'row',
        paddingVertical: 14,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10
    },
    actionBtnOutline: {
        flex: 1,
        borderWidth: 1.5,
        borderColor: '#667B53',
        paddingVertical: 14,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center'
    },
    actionBtnText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 11
    },
    actionBtnTextOutline: {
        color: '#667B53',
        fontFamily: 'Montserrat-Bold',
        fontSize: 11,
        marginLeft: 5
    },
    parcelStat: {
        marginTop: 12,
        alignItems: 'center'
    },
    parcelStatText: {
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        color: '#A2845E'
    },
    cloudInfo: {
        backgroundColor: '#F0F5EB',
        borderRadius: 12,
        padding: 12,
        marginBottom: 15,
        borderWidth: 1,
        borderColor: '#B7D098'
    },
    cloudRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4
    },
    cloudText: {
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        color: '#3C493A',
        marginLeft: 6,
        flex: 1
    },

    // Compact List Item
    photoCard: {
        flexDirection: 'row',
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 10,
        marginBottom: 12,
        alignItems: 'center',
        elevation: 3,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
    },
    thumbContainer: {
        width: 80,
        height: 60,
        borderRadius: 10,
        backgroundColor: '#f0f0f0',
        overflow: 'hidden',
        justifyContent: 'center',
        alignItems: 'center'
    },
    photoThumb: {
        width: 60,
        height: 80,
        transform: [{ rotate: '270deg' }]
    },
    photoInfo: {
        flex: 1,
        marginLeft: 15,
        justifyContent: 'center'
    },
    cardTitle: {
        fontSize: 14,
        fontFamily: 'Montserrat-Bold',
        color: '#313B28',
        marginBottom: 4
    },
    cardSub: {
        flexDirection: 'row',
        alignItems: 'center'
    },
    cardDate: {
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        color: '#5E462F',
        marginLeft: 4
    },
    cardTime: {
        fontSize: 10,
        fontFamily: 'Montserrat-Regular',
        color: '#5E462F',
        marginLeft: 4
    },
    weatherText: {
        fontSize: 9,
        fontFamily: 'Montserrat-SemiBold',
        color: '#667B53',
        marginLeft: 4
    },
    ndviBadgeSmall: {
        backgroundColor: '#667B53',
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 4,
        marginLeft: 8
    },
    ndviBadgeText: {
        color: 'white',
        fontSize: 8,
        fontFamily: 'Montserrat-Bold'
    },
    cardTime: {
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        color: '#5E462F',
        marginLeft: 4
    },
    deleteBtnCompact: {
        padding: 10,
        marginLeft: 5
    },

    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 60,
        padding: 40
    },
    emptyText: {
        color: '#3C493A',
        marginTop: 20,
        fontSize: 15,
        fontFamily: 'Montserrat-SemiBold',
        textAlign: 'center',
        lineHeight: 24
    },
    loadingText: {
        marginTop: 15,
        fontFamily: 'Montserrat-Bold',
        color: '#667B53',
        fontSize: 12,
        letterSpacing: 1
    },

    // Modal Styles
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(247, 238, 227, 0.95)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 30,
    },
    modalContent: {
        backgroundColor: 'white',
        borderRadius: 30,
        padding: 30,
        width: '100%',
        elevation: 20,
        borderWidth: 1,
        borderColor: '#B7D098'
    },
    modalTitle: {
        fontSize: 18,
        fontFamily: 'Montserrat-Bold',
        marginBottom: 20,
        textAlign: 'center',
        color: '#3C493A'
    },
    yearInput: {
        backgroundColor: '#F7EEE3',
        borderRadius: 15,
        padding: 18,
        fontSize: 22,
        fontFamily: 'Montserrat-Bold',
        textAlign: 'center',
        color: '#667B53',
        marginBottom: 25
    },
    modalButtons: {
        flexDirection: 'row',
        gap: 15
    },
    modalBtn: {
        flex: 1,
        paddingVertical: 16,
        borderRadius: 14,
        alignItems: 'center',
    },
    cancelBtn: { backgroundColor: '#f0f0f0' },
    confirmBtn: { backgroundColor: '#667B53' },
    cancelBtnText: { fontFamily: 'Montserrat-Bold', color: '#888' },
    confirmBtnText: { fontFamily: 'Montserrat-Bold', color: 'white' },

    fullscreenOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeFullscreenBtn: {
        position: 'absolute',
        top: 60, right: 30,
        zIndex: 100
    },
    fullscreenImage: {
        width: '100%',
        height: '100%',
    },
});
