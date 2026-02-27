import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, FlatList, TouchableOpacity, Alert, ActivityIndicator, Modal, TextInput } from 'react-native';
import { supabase, fetchAllPhotoLocations, fetchParcels, fetchCroppingYears, insertParcels, insertCroppingYear } from '../lib/supabase';
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

            const { data, error } = await supabase
                .from('photos')
                .select('*')
                .eq('user_id', user.id)
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

    const handleLogout = async () => {
        await supabase.auth.signOut();
    };

    const renderItem = ({ item }) => (
        <View style={styles.photoCard}>
            <TouchableOpacity onPress={() => setFullscreenPhoto(item.image_url)}>
                <Image source={{ uri: item.image_url }} style={styles.photoThumb} contentFit="cover" />
            </TouchableOpacity>
            <View style={styles.photoInfo}>
                <Text style={styles.photoDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
                <View style={styles.photoMetaRow}>
                    <Text style={styles.photoTime}>{new Date(item.created_at).toLocaleTimeString()}</Text>
                    {item.parcel_name && (
                        <Text style={styles.photoParcel}> • {item.parcel_name}</Text>
                    )}
                </View>
            </View>
            <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item)}>
                <Ionicons name="trash-outline" size={24} color="#FF3B30" />
            </TouchableOpacity>
        </View>
    );

    return (
        <>
            <Modal
                visible={showYearModal}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setShowYearModal(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>NIEUW TEELTJAAR</Text>
                        <TextInput
                            style={styles.yearInput}
                            value={newYearInput}
                            onChangeText={setNewYearInput}
                            keyboardType="numeric"
                            placeholder="Bijv. 2026"
                        />
                        <View style={styles.modalButtons}>
                            <TouchableOpacity
                                style={[styles.modalBtn, styles.cancelBtn]}
                                onPress={() => setShowYearModal(false)}
                            >
                                <Text style={styles.cancelBtnText}>ANNULEREN</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.modalBtn, styles.confirmBtn]}
                                onPress={handleAddYear}
                                disabled={isCreatingYear}
                            >
                                {isCreatingYear ? (
                                    <ActivityIndicator color="white" size="small" />
                                ) : (
                                    <Text style={styles.confirmBtnText}>AANMAKEN</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            <Modal
                visible={!!fullscreenPhoto}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setFullscreenPhoto(null)}
            >
                <View style={styles.fullscreenOverlay}>
                    <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenPhoto(null)}>
                        <Ionicons name="close-circle" size={40} color="white" />
                    </TouchableOpacity>
                    {fullscreenPhoto && (
                        <Image source={{ uri: fullscreenPhoto }} style={styles.fullscreenImage} contentFit="contain" />
                    )}
                </View>
            </Modal>



            <View style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.title}>MIJN FOTO'S</Text>
                    <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
                        <Ionicons name="log-out-outline" size={18} color="#D51317" />
                        <Text style={styles.logoutText}>LOG UIT</Text>
                    </TouchableOpacity>
                </View>

                {loading && !refreshing ? (
                    <View style={styles.center}>
                        <ActivityIndicator size="large" color="#667B53" />
                    </View>
                ) : (
                    <FlatList
                        data={[{ id: 'header' }, ...photos]}
                        keyExtractor={(item) => item.id.toString()}
                        onRefresh={() => { setRefreshing(true); loadInitialData(); }}
                        refreshing={refreshing}
                        contentContainerStyle={styles.list}
                        renderItem={({ item }) => {
                            if (item.id === 'header') {
                                return (
                                    <View style={styles.sectionContainer}>
                                        <View style={styles.sectionHeader}>
                                            <Text style={styles.sectionTitle}>TEELTJAAR & PERCELEN</Text>
                                        </View>

                                        <View style={styles.yearPicker}>
                                            {years.map(y => (
                                                <TouchableOpacity
                                                    key={y.year}
                                                    style={[styles.yearBtn, selectedYear === y.year && styles.yearBtnActive]}
                                                    onPress={() => handleYearChange(y.year)}
                                                >
                                                    <Text style={[styles.yearBtnText, selectedYear === y.year && styles.yearBtnActiveText]}>
                                                        {y.year}
                                                    </Text>
                                                </TouchableOpacity>
                                            ))}
                                            <TouchableOpacity
                                                style={styles.addYearBtn}
                                                onPress={() => setShowYearModal(true)}
                                            >
                                                <Ionicons name="add-circle" size={24} color="#667B53" />
                                                <Text style={styles.addYearBtnText}>NIEUW</Text>
                                            </TouchableOpacity>
                                        </View>

                                        <View style={styles.uploadRow}>
                                            <TouchableOpacity
                                                style={[styles.uploadBtn, { flex: 1 }]}
                                                onPress={handleUploadShapefile}
                                                disabled={uploadingParcels}
                                            >
                                                <Ionicons name="document-outline" size={18} color="white" />
                                                <Text style={styles.uploadBtnText}>SHAPEFILE UPLOADEN (.ZIP)</Text>
                                            </TouchableOpacity>
                                        </View>

                                        {parcels.length > 0 && (
                                            <View style={styles.parcelList}>
                                                <Text style={styles.parcelCountText}>{parcels.length} percelen geladen</Text>
                                                <View style={styles.parcelChips}>
                                                    {parcels.slice(0, 10).map(p => (
                                                        <View key={p.id} style={styles.parcelChip}>
                                                            <Text style={styles.parcelChipText}>{p.name}</Text>
                                                        </View>
                                                    ))}
                                                    {parcels.length > 10 && <Text style={styles.moreText}>+{parcels.length - 10} meer...</Text>}
                                                </View>
                                            </View>
                                        )}

                                        <View style={[styles.sectionHeader, { marginTop: 30 }]}>
                                            <Text style={styles.sectionTitle}>MIJN FOTO'S</Text>
                                        </View>
                                    </View>
                                );
                            }
                            return renderItem({ item });
                        }}
                        ListEmptyComponent={
                            <View style={styles.emptyContainer}>
                                <Ionicons name="images-outline" size={60} color="#ccc" />
                                <Text style={styles.emptyText}>Je hebt nog geen foto's gemaakt.</Text>
                            </View>
                        }
                    />
                )}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7EEE3' },
    header: {
        paddingTop: 60,
        paddingHorizontal: 20,
        paddingBottom: 20,
        backgroundColor: '#FFFFFF',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        elevation: 2,
        borderBottomWidth: 1,
        borderBottomColor: '#B7D098',
    },
    title: {
        fontSize: 20,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 2,
        color: '#000000'
    },
    logoutBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFFFFF',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#D51317',
    },
    logoutText: {
        color: '#D51317',
        fontFamily: 'Montserrat-Bold',
        marginLeft: 5,
        fontSize: 12,
    },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    list: { padding: 15 },
    photoCard: {
        flexDirection: 'row',
        backgroundColor: 'white',
        borderRadius: 10,
        padding: 10,
        marginBottom: 10,
        alignItems: 'center',
        elevation: 1,
        borderLeftWidth: 4,
        borderLeftColor: '#667B53',
    },
    photoThumb: { width: 90, height: 60, borderRadius: 4 },
    photoInfo: { flex: 1, marginLeft: 15 },
    photoDate: {
        fontSize: 14,
        fontFamily: 'Montserrat-Bold',
        color: '#3C493A'
    },
    photoTime: {
        fontSize: 11,
        fontFamily: 'Montserrat-Regular',
        color: '#5E462F',
    },
    photoMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 2,
    },
    photoParcel: {
        fontSize: 11,
        fontFamily: 'Montserrat-SemiBold',
        color: '#667B53',
    },
    deleteBtn: { padding: 10 },
    emptyContainer: { alignItems: 'center', marginTop: 100 },
    emptyText: {
        color: '#3C493A',
        marginTop: 15,
        fontSize: 14,
        fontFamily: 'Montserrat-Regular'
    },
    sectionContainer: {
        marginBottom: 20,
        backgroundColor: 'white',
        borderRadius: 15,
        padding: 20,
        elevation: 2,
        borderWidth: 1,
        borderColor: '#B7D098',
    },
    sectionHeader: {
        marginBottom: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#F7EEE3',
        paddingBottom: 8,
    },
    sectionTitle: {
        fontSize: 14,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 1.5,
        color: '#3C493A',
    },
    yearPicker: {
        flexDirection: 'row',
        marginBottom: 20,
    },
    yearBtn: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#667B53',
        marginRight: 10,
    },
    yearBtnActive: {
        backgroundColor: '#667B53',
    },
    yearBtnText: {
        fontFamily: 'Montserrat-Bold',
        color: '#667B53',
    },
    yearBtnActiveText: {
        color: 'white',
    },
    uploadBtn: {
        flexDirection: 'row',
        backgroundColor: '#5E462F', // Brown
        padding: 15,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    uploadBtnText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 10,
        marginLeft: 8,
        letterSpacing: 0.5,
    },
    uploadRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    pickerContainer: {
        flex: 1,
        backgroundColor: '#F7EEE3',
    },
    pickerHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 60,
        paddingHorizontal: 15,
        paddingBottom: 20,
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#B7D098',
    },
    pickerTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    backBtn: {
        marginRight: 15,
        padding: 5,
    },
    pickerTitle: {
        fontSize: 16,
        fontFamily: 'Montserrat-Bold',
        letterSpacing: 1,
    },
    pickerList: {
        padding: 20,
    },
    driveFileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 12,
        marginBottom: 10,
        elevation: 1,
    },
    driveFileInfo: {
        flex: 1,
        marginLeft: 15,
    },
    driveFileName: {
        fontSize: 14,
        fontFamily: 'Montserrat-SemiBold',
        color: '#3C493A',
    },
    driveFileDate: {
        fontSize: 11,
        fontFamily: 'Montserrat-Regular',
        color: '#999',
        marginTop: 2,
    },
    loadingText: {
        marginTop: 15,
        fontFamily: 'Montserrat-Regular',
        color: '#666',
    },
    processingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 100,
    },
    processingText: {
        color: 'white',
        marginTop: 15,
        fontFamily: 'Montserrat-Bold',
    },
    parcelList: {
        marginTop: 15,
    },
    parcelCountText: {
        fontSize: 12,
        fontFamily: 'Montserrat-SemiBold',
        color: '#666',
        marginBottom: 10,
    },
    parcelChips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    parcelChip: {
        backgroundColor: '#F7EEE3',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 15,
        marginRight: 8,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#B7D098',
    },
    parcelChipText: {
        fontSize: 10,
        fontFamily: 'Montserrat-Regular',
        color: '#3C493A',
    },
    moreText: {
        fontSize: 10,
        fontFamily: 'Montserrat-Italic',
        color: '#666',
        marginTop: 5,
    },
    addYearBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        backgroundColor: '#FFFFFF',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#B7D098',
        borderStyle: 'dashed',
    },
    addYearBtnText: {
        fontSize: 10,
        fontFamily: 'Montserrat-Bold',
        color: '#667B53',
        marginLeft: 4,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalContent: {
        backgroundColor: 'white',
        borderRadius: 20,
        padding: 25,
        width: '100%',
        maxWidth: 400,
        elevation: 5,
    },
    modalTitle: {
        fontSize: 18,
        fontFamily: 'Montserrat-Bold',
        color: '#3C493A',
        marginBottom: 20,
        textAlign: 'center',
        letterSpacing: 1,
    },
    yearInput: {
        borderWidth: 1,
        borderColor: '#B7D098',
        borderRadius: 10,
        padding: 15,
        fontSize: 20,
        fontFamily: 'Montserrat-Bold',
        textAlign: 'center',
        color: '#000',
        marginBottom: 25,
    },
    modalButtons: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    modalBtn: {
        flex: 0.48,
        paddingVertical: 15,
        borderRadius: 10,
        alignItems: 'center',
    },
    cancelBtn: {
        backgroundColor: '#F7EEE3',
    },
    confirmBtn: {
        backgroundColor: '#667B53',
    },
    cancelBtnText: {
        color: '#5E462F',
        fontFamily: 'Montserrat-Bold',
        fontSize: 12,
    },
    confirmBtnText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 12,
    },
    fullscreenOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeFullscreenBtn: {
        position: 'absolute',
        top: 50,
        right: 20,
        zIndex: 10,
        padding: 10,
    },
    fullscreenImage: {
        width: '100%',
        height: '100%',
    },
});
