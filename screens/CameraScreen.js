import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState, useRef, useEffect } from 'react';
import { Button, StyleSheet, Text, TouchableOpacity, View, Alert, ActivityIndicator, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { supabase, fetchNearestPhoto, fetchParcels, fetchCroppingYears } from '../lib/supabase';
import { saveToQueue, getQueue, removeFromQueue } from '../lib/offlineQueue';
import { Ionicons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as turf from '@turf/turf';
import * as FileSystem from 'expo-file-system/legacy';
import { GoogleDrive } from '../lib/googleDrive';

export default function CameraScreen({ route }) {
    const [facing, setFacing] = useState('back');
    const [permission, requestPermission] = useCameraPermissions();
    const [locationPermission, requestLocationPermission] = Location.useForegroundPermissions();
    const [uploading, setUploading] = useState(false);
    const [ghostImage, setGhostImage] = useState(null);
    const [loadingGhost, setLoadingGhost] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    const [pendingCount, setPendingCount] = useState(0);
    const [syncing, setSyncing] = useState(false);
    const [activeParcels, setActiveParcels] = useState([]);
    const [activeYear, setActiveYear] = useState(null);
    const [backupStatus, setBackupStatus] = useState('idle'); // idle, backing-up, success, error

    // Use Dimensions for basic sizing, but ScreenOrientation for rotation logic
    const [dims, setDims] = useState(Dimensions.get('window'));
    const [sensorLandscape, setSensorLandscape] = useState(Dimensions.get('window').width > Dimensions.get('window').height);

    useEffect(() => {
        const prepareOrientation = async () => {
            try {
                // Force permission to rotate in this screen
                await ScreenOrientation.unlockAsync();
                const current = await ScreenOrientation.getOrientationAsync();
                console.log("[Camera] Initial Orientation:", current);
                setSensorLandscape(
                    current === ScreenOrientation.Orientation.LANDSCAPE_LEFT ||
                    current === ScreenOrientation.Orientation.LANDSCAPE_RIGHT
                );
            } catch (e) {
                console.warn("[Camera] ScreenOrientation Error:", e);
            }
        };

        prepareOrientation();

        const subscription = ScreenOrientation.addOrientationChangeListener((event) => {
            const o = event.orientationInfo.orientation;
            const landscape =
                o === ScreenOrientation.Orientation.LANDSCAPE_LEFT ||
                o === ScreenOrientation.Orientation.LANDSCAPE_RIGHT;

            console.log(`[Camera] New Orientation: ${landscape ? 'LANDSCAPE' : 'PORTRAIT'}`);
            setSensorLandscape(landscape);
            setDims(Dimensions.get('window'));
        });

        return () => {
            ScreenOrientation.removeOrientationChangeListener(subscription);
        };
    }, []);

    const isLandscape = sensorLandscape;


    const { width, height } = dims;

    const cameraRef = useRef(null);

    useEffect(() => {
        (async () => {
            if (!permission?.granted) await requestPermission();
            if (!locationPermission?.granted) await requestLocationPermission();
            checkQueue();
            loadParcels();
        })();

        const unsubscribe = NetInfo.addEventListener(state => {
            setIsConnected(state.isConnected);
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (route?.params?.ghostImage) {
            setGhostImage(route.params.ghostImage);
        } else if (locationPermission?.granted && isConnected) {
            updateGhostImage();
        }
    }, [isConnected, locationPermission, route?.params?.ghostImage]);

    const checkQueue = async () => {
        const queue = await getQueue();
        setPendingCount(queue.length);
    };

    const loadParcels = async () => {
        try {
            const years = await fetchCroppingYears();
            const year = years.find(y => y.is_active) || years[0];
            if (year) {
                setActiveYear(year.year);
                const parcels = await fetchParcels(year.year);
                setActiveParcels(parcels);
                console.log(`[Camera] Loaded ${parcels.length} parcels for ${year.year}`);
            }
        } catch (e) {
            console.error("Error loading parcels in camera:", e);
        }
    };

    const findParcelName = (lat, lon) => {
        if (!activeParcels || activeParcels.length === 0) return null;
        const point = turf.point([lon, lat]);
        for (const parcel of activeParcels) {
            if (parcel.geometry && turf.booleanPointInPolygon(point, parcel.geometry)) {
                return parcel.name;
            }
        }
        return null;
    };

    const updateGhostImage = async () => {
        setLoadingGhost(true);
        try {
            const loc = await Location.getCurrentPositionAsync({});
            const nearestUrl = await fetchNearestPhoto(loc.coords.latitude, loc.coords.longitude);
            if (nearestUrl) setGhostImage(nearestUrl);
        } catch (e) {
            console.log("Error fetching ghost image:", e);
        } finally {
            setLoadingGhost(false);
        }
    };

    if (!permission || !locationPermission) return <View />;
    if (!permission.granted) {
        return (
            <View style={styles.container}>
                <Text style={styles.message}>Toestemming nodig voor camera.</Text>
                <Button onPress={requestPermission} title="Geef toegang" />
            </View>
        );
    }

    const triggerGoogleBackup = async (uri, fileName) => {
        setBackupStatus('backing-up');
        try {
            console.log("[Camera] Starting Google Drive backup for:", fileName);
            const base64 = await FileSystem.readAsStringAsync(uri, {
                encoding: 'base64',
            });
            const driveId = await GoogleDrive.uploadFile(fileName, 'image/jpeg', base64);
            if (driveId) {
                console.log("[Camera] Google Drive backup successful, ID:", driveId);
                setBackupStatus('success');
                setTimeout(() => setBackupStatus('idle'), 3000);
            } else {
                throw new Error("No Drive ID returned");
            }
        } catch (e) {
            console.error("[Camera] Google Drive backup failed:", e);
            setBackupStatus('error');
            setTimeout(() => setBackupStatus('idle'), 5000);
        }
    };

    const uploadToSupabase = async (uri, location, parcelName) => {
        console.log("[Camera] Starting upload sequence...");

        // Custom name format: YYYY-MM-DD_HH-mm_ParcelName.jpg
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5);
        const sanitizeParcel = (parcelName || "Onbekend").replace(/[^a-z0-9]/gi, '_');
        const fileName = `${dateStr}_${timeStr}_${sanitizeParcel}_${Date.now()}.jpg`;

        const formData = new FormData();
        formData.append('file', {
            uri,
            name: fileName,
            type: 'image/jpeg',
        });

        console.log("[Camera] Uploading to Storage bucket 'photos'...");
        const { error: uploadError } = await supabase.storage
            .from('photos')
            .upload(fileName, formData, { contentType: 'image/jpeg' });

        if (uploadError) {
            console.error("[Camera] Storage upload error:", uploadError);
            throw uploadError;
        }

        const { data: { publicUrl } } = supabase.storage
            .from('photos')
            .getPublicUrl(fileName);

        console.log("[Camera] Storage upload success. URL:", publicUrl);

        console.log("[Camera] Fetching user with timeout...");
        const userPromise = supabase.auth.getUser();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("User fetch timed out during upload")), 5000)
        );

        let user = null;
        try {
            const { data } = await Promise.race([userPromise, timeoutPromise]);
            user = data.user;
            console.log("[Camera] User found:", user?.email || "Anonymous");
        } catch (e) {
            console.warn("[Camera] User fetch failed/timed out, proceeding as anonymous:", e.message);
        }

        console.log("[Camera] Inserting into DB table 'photos'...");
        const insertData = {
            image_url: publicUrl,
            latitude: location?.coords?.latitude || null,
            longitude: location?.coords?.longitude || null,
            created_at: location?.timestamp ? new Date(location.timestamp).toISOString() : new Date().toISOString(),
            user_id: user?.id || null,
            user_email: user?.email || null,
            parcel_name: parcelName || null,
            cropping_year: activeYear || null,
        };

        const { data: dbData, error: dbError } = await supabase
            .from('photos')
            .insert(insertData)
            .select();

        if (dbError) {
            console.error("[Camera] Database insert error:", dbError);
            throw dbError;
        }

        console.log("[Camera] DB insert success:", dbData);
        return publicUrl;
    };

    const takePhoto = async () => {
        if (cameraRef.current && !uploading) {
            try {
                setUploading(true);
                let location = await Location.getCurrentPositionAsync({});

                const photo = await cameraRef.current.takePictureAsync({
                    exif: true,
                    skipProcessing: false,
                });

                if (isConnected) {
                    try {
                        const parcelName = findParcelName(location.coords.latitude, location.coords.longitude);
                        const publicUrl = await uploadToSupabase(photo.uri, location, parcelName);
                        setGhostImage(publicUrl);

                        // Async backup - don't await to not block the UI
                        const now = new Date();
                        const dateStr = now.toISOString().split('T')[0];
                        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5);
                        const sanitizeParcel = (parcelName || "Onbekend").replace(/[^a-z0-9]/gi, '_');
                        const fileName = `${dateStr}_${timeStr}_${sanitizeParcel}_${Date.now()}.jpg`;
                        triggerGoogleBackup(photo.uri, fileName);

                        Alert.alert('Succes', `Foto geüpload! Perceel: ${parcelName || 'Onbekend'}`);
                    } catch (e) {
                        await saveToQueue(photo.uri, location);
                        await checkQueue();
                        Alert.alert("Opgeslagen", "Upload mislukt, lokaal opgeslagen.");
                    }
                } else {
                    await saveToQueue(photo.uri, location);
                    await checkQueue();
                    Alert.alert("Offline", "Foto lokaal opgeslagen.");
                }
            } catch (e) {
                Alert.alert('Fout', e.message);
            } finally {
                setUploading(false);
            }
        }
    };

    const syncQueue = async () => {
        if (syncing) return;
        setSyncing(true);
        const queue = await getQueue();
        let successCount = 0;
        for (const item of queue) {
            try {
                const parcelName = findParcelName(item.location.coords.latitude, item.location.coords.longitude);
                const publicUrl = await uploadToSupabase(item.uri, item.location, parcelName);

                // Trigger Drive backup for synced items too
                const now = new Date();
                const dateStr = now.toISOString().split('T')[0];
                const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5);
                const sanitizeParcel = (parcelName || "Onbekend").replace(/[^a-z0-9]/gi, '_');
                const fileName = `${dateStr}_${timeStr}_${sanitizeParcel}_${Date.now()}.jpg`;
                triggerGoogleBackup(item.uri, fileName);

                await removeFromQueue(item.id);
                successCount++;
            } catch (e) {
                console.error("Sync failed for item:", item.id);
            }
        }
        await checkQueue();
        setSyncing(false);
        Alert.alert("Sync Klaar", `${successCount} fotos geüpload.`);
        if (successCount > 0) updateGhostImage();
    };

    return (
        <View style={styles.container}>
            <CameraView style={styles.camera} facing={facing} ref={cameraRef} />

            {/* UI Overlays OUTSIDE of CameraView */}
            <View
                style={[
                    styles.ghostOverlay,
                    {
                        width: '100%',
                        height: isLandscape ? height : width * (16 / 9),
                        top: isLandscape ? 0 : '50%',
                        marginTop: isLandscape ? 0 : -(width * (16 / 9) / 2)
                    }
                ]}
                pointerEvents="none"
            >
                {ghostImage && (
                    <Image source={{ uri: ghostImage }} style={styles.ghostImage} contentFit="cover" />
                )}
            </View>

            <View style={[styles.topBar, isLandscape && styles.topBarLandscape]}>
                <View style={[styles.statusBadge, { backgroundColor: isConnected ? '#667B53' : '#D51317' }]}>
                    <Text style={styles.statusText}>{isConnected ? 'ONLINE' : 'OFFLINE'}</Text>
                </View>

                <View style={styles.orientationIndicator}>
                    <Ionicons
                        name={sensorLandscape ? "resize" : "phone-portrait-outline"}
                        size={16}
                        color="white"
                        style={{ opacity: 0.8 }}
                    />
                    <Text style={styles.orientationText}>{sensorLandscape ? "LANDSCAPE" : "PORTRAIT"}</Text>
                </View>

                {backupStatus !== 'idle' && (
                    <View style={[styles.backupBadge, backupStatus === 'error' && styles.backupError]}>
                        <Ionicons
                            name={backupStatus === 'backing-up' ? "cloud-upload" : (backupStatus === 'success' ? "cloud-done" : "cloud-offline")}
                            size={14}
                            color="white"
                        />
                        <Text style={styles.backupText}>
                            {backupStatus === 'backing-up' ? 'BACK-UP...' : (backupStatus === 'success' ? 'BACK-UP OK' : 'BACK-UP FOUT')}
                        </Text>
                    </View>
                )}
            </View>

            <View style={[styles.bottomBar, isLandscape && styles.sidebar]}>
                <TouchableOpacity style={styles.sideButton} onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}>
                    <Ionicons name="camera-reverse" size={32} color="white" />
                </TouchableOpacity>

                <TouchableOpacity style={styles.captureButton} onPress={takePhoto} disabled={uploading}>
                    {uploading ? <ActivityIndicator color="white" /> : <View style={styles.captureInner} />}
                </TouchableOpacity>

                {pendingCount > 0 ? (
                    <TouchableOpacity style={styles.syncButtonSmall} onPress={syncQueue} disabled={syncing || !isConnected}>
                        <Text style={styles.syncTextSmall}>{pendingCount}</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={styles.spacer} />
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'black' },
    camera: { flex: 1 },
    ghostOverlay: {
        position: 'absolute',
        opacity: 0.35,
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        zIndex: 5,
    },
    ghostImage: { width: '100%', height: '100%' },
    topBar: {
        position: 'absolute',
        top: 60, left: 0, right: 0,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 25,
        zIndex: 15,
    },
    topBarLandscape: {
        top: 30,
        paddingRight: 110,
    },
    bottomBar: {
        position: 'absolute',
        bottom: 50, left: 0, right: 0,
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        zIndex: 15,
    },
    sidebar: {
        top: 0, bottom: 0, right: 0, left: 'auto',
        width: 100,
        flexDirection: 'column',
        justifyContent: 'space-around',
        backgroundColor: 'rgba(0,0,0,0.4)',
        paddingVertical: 50,
        zIndex: 15,
    },
    sideButton: { padding: 10 },
    captureButton: {
        width: 80, height: 80, borderRadius: 40,
        borderWidth: 5, borderColor: 'white',
        backgroundColor: 'rgba(255,255,255,0.2)',
        justifyContent: 'center', alignItems: 'center',
    },
    captureInner: {
        width: 60, height: 60, borderRadius: 30,
        backgroundColor: '#667B53' // Brand Green
    },
    statusBadge: {
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20
    },
    statusText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 10,
        letterSpacing: 1
    },
    orientationIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(60, 73, 58, 0.7)', // Dark Green transparent
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10
    },
    orientationText: {
        color: 'white',
        fontSize: 10,
        fontFamily: 'Montserrat-Bold',
        marginLeft: 5,
        letterSpacing: 0.5
    },
    backupBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#5E462F', // brown
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10,
        marginLeft: 10,
    },
    backupError: {
        backgroundColor: '#D51317',
    },
    backupText: {
        color: 'white',
        fontSize: 10,
        fontFamily: 'Montserrat-Bold',
        marginLeft: 5,
    },
    topBarGroup: { flexDirection: 'row', alignItems: 'center' },
    orientationToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.2)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 10,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.3)'
    },
    orientationToggleActive: {
        backgroundColor: '#007AFF',
        borderColor: '#007AFF',
    },
    syncButtonSmall: {
        backgroundColor: '#3C493A', // Dark Green
        width: 44, height: 44, borderRadius: 22,
        justifyContent: 'center', alignItems: 'center'
    },
    syncTextSmall: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 13
    },
    spacer: { width: 44 },
    message: { color: 'white', textAlign: 'center', marginTop: 100 },
});
