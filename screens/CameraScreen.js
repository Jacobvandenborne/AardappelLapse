import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState, useRef, useEffect } from 'react';
import { Button, StyleSheet, Text, TouchableOpacity, View, Alert, ActivityIndicator, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { supabase, fetchNearestPhoto, fetchParcels, fetchCroppingYears, GOOGLE_DRIVE_FOLDERS } from '../lib/supabase';
import { saveToQueue, getQueue, removeFromQueue } from '../lib/offlineQueue';
import { Ionicons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as turf from '@turf/turf';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { GoogleDrive } from '../lib/googleDrive';
import Slider from '@react-native-community/slider';

// Helper to fetch weather data (Option 5)
const fetchWeather = async (lat, lon) => {
    try {
        const API_KEY = 'YOUR_OPENWEATHERMAP_API_KEY'; // Replace with real key
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.main) {
            return {
                temp: data.main.temp,
                description: data.weather[0]?.description,
                humidity: data.main.humidity
            };
        }
        return null;
    } catch (e) {
        console.warn("[Weather] Fetch failed:", e.message);
        return null;
    }
};

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
    const [ghostOpacity, setGhostOpacity] = useState(0.35);

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
        let watchId = null;
        if (locationPermission?.granted && isConnected && !route?.params?.ghostImage) {
            (async () => {
                // Initial load
                updateGhostImage();

                // Watch for changes, but with better accuracy and a fallback
                try {
                    console.log("[Camera] Starting location watch for Ghost Image...");
                    watchId = await Location.watchPositionAsync(
                        {
                            accuracy: Location.Accuracy.BestForNavigation,
                            distanceInterval: 5 // Smaller interval for better precision
                        },
                        (loc) => {
                            console.log("[Camera] Location updated, checking for ghost image...");
                            updateGhostImage(loc);
                        }
                    );
                } catch (e) {
                    console.warn("[Camera] Location watch error:", e);
                }
            })();
        }
        return () => {
            if (watchId) watchId.remove();
        };
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

    const updateGhostImage = async (providedLoc = null) => {
        if (loadingGhost) return;
        setLoadingGhost(true);
        try {
            const loc = providedLoc || await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            const nearestUrl = await fetchNearestPhoto(loc.coords.latitude, loc.coords.longitude);

            // Only update if it actually changed to prevent flickering
            if (nearestUrl !== ghostImage) {
                console.log("[Camera] Updating Ghost Image to:", nearestUrl ? "Success" : "None found nearby");
                setGhostImage(nearestUrl);
            }
        } catch (e) {
            console.log("Error fetching ghost image:", e);
            setGhostImage(null);
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

    const triggerGoogleBackup = async (uri, fileName, folderId = null) => {
        setBackupStatus('backing-up');
        try {
            console.log("[Camera] Starting Google Drive backup for:", fileName, "Folder:", folderId);
            const base64 = await FileSystem.readAsStringAsync(uri, {
                encoding: 'base64',
            });
            const driveId = await GoogleDrive.uploadFile(fileName, 'image/jpeg', base64, folderId);

            console.log("[Camera] Google Drive backup successful, ID:", driveId);
            setBackupStatus('success');
            setTimeout(() => setBackupStatus('idle'), 3000);
            return driveId;
        } catch (e) {
            console.error("[Camera] Google Drive backup failed:", e.message);

            if (e.message === 'AUTH_MISSING') {
                setBackupStatus('error-auth');
                console.warn("[Camera] Backup failed due to missing Google Token.");
            } else {
                setBackupStatus('error');
            }

            setTimeout(() => setBackupStatus('idle'), 6000);
            return null;
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

        // Fetch weather data (Option 5)
        let weather = null;
        if (location?.coords) {
            weather = await fetchWeather(location.coords.latitude, location.coords.longitude);
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
            // Advanced features
            weather_temp: weather?.temp || null,
            weather_description: weather?.description || null,
            weather_humidity: weather?.humidity || null,
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
        return { publicUrl, record: dbData[0] };
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

                // Correct for sensor orientation: Rotate based on whether we are currently in landscape
                console.log("[Camera] Correcting orientation. IsLandscape:", isLandscape);
                const rotation = isLandscape ? 270 : 0; // Rotate 270 if landscape, else keep as is
                const manipulated = await manipulateAsync(
                    photo.uri,
                    [{ rotate: rotation }],
                    { compress: 0.8, format: SaveFormat.JPEG }
                );

                if (isConnected) {
                    try {
                        const parcelName = route?.params?.forcedParcelName || findParcelName(location.coords.latitude, location.coords.longitude);
                        const { publicUrl, record } = await uploadToSupabase(manipulated.uri, location, parcelName);
                        setGhostImage(publicUrl);

                        // Async backup - handle status update in background
                        (async () => {
                            const now = new Date();
                            const dateStr = now.toISOString().split('T')[0];
                            const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5);
                            const sanitizeParcel = (parcelName || "Onbekend").replace(/[^a-z0-9]/gi, '_');
                            const fileName = `${dateStr}_${timeStr}_${sanitizeParcel}_${Date.now()}.jpg`;
                            const driveFolderId = GOOGLE_DRIVE_FOLDERS[activeYear] || null;
                            const driveId = await triggerGoogleBackup(manipulated.uri, fileName, driveFolderId);

                            if (driveId && record?.id) {
                                // Update Supabase with the Drive ID for the icon in Management
                                await supabase.from('photos').update({ google_drive_id: driveId }).eq('id', record.id);
                            }
                        })();

                        Alert.alert('Succes', `Foto geüpload! Perceel: ${parcelName || 'Onbekend'}`);
                    } catch (e) {
                        await saveToQueue(manipulated.uri, location, parcelName);
                        await checkQueue();
                        Alert.alert("Opgeslagen", "Upload mislukt, lokaal opgeslagen.");
                    }
                } else {
                    const localParcel = route?.params?.forcedParcelName || findParcelName(location.coords.latitude, location.coords.longitude);
                    await saveToQueue(manipulated.uri, location, localParcel);
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
                const parcelName = item.parcelName || findParcelName(item.location.coords.latitude, item.location.coords.longitude);
                const publicUrl = await uploadToSupabase(item.uri, item.location, parcelName);

                // Trigger Drive backup for synced items too
                const now = new Date();
                const dateStr = now.toISOString().split('T')[0];
                const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-').slice(0, 5);
                const sanitizeParcel = (parcelName || "Onbekend").replace(/[^a-z0-9]/gi, '_');
                const fileName = `${dateStr}_${timeStr}_${sanitizeParcel}_${Date.now()}.jpg`;
                const driveFolderId = GOOGLE_DRIVE_FOLDERS[activeYear] || null;
                triggerGoogleBackup(item.uri, fileName, driveFolderId);

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

            <View
                style={[
                    styles.ghostOverlay,
                    {
                        width: '100%',
                        height: '100%',
                        opacity: ghostOpacity,
                        justifyContent: 'center',
                        alignItems: 'center'
                    }
                ]}
                pointerEvents="none"
            >
                {ghostImage && (
                    <Image
                        source={{ uri: ghostImage }}
                        style={[
                            styles.ghostImage,
                            {
                                transform: [{ rotate: '270deg' }],
                                width: isLandscape ? width : height,
                                height: isLandscape ? height : width
                            }
                        ]}
                        contentFit="contain"
                    />
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
                    <View style={[
                        styles.backupBadge,
                        (backupStatus === 'error' || backupStatus === 'error-auth') && styles.backupError
                    ]}>
                        <Ionicons
                            name={backupStatus === 'backing-up' ? "cloud-upload" : (backupStatus === 'success' ? "cloud-done" : "cloud-offline")}
                            size={14}
                            color="white"
                        />
                        <Text style={styles.backupText}>
                            {backupStatus === 'backing-up' ? 'BACK-UP...' :
                                (backupStatus === 'success' ? 'BACK-UP OK' :
                                    (backupStatus === 'error-auth' ? 'LOG-IN VERLOPEN' : 'BACK-UP FOUT'))}
                        </Text>
                    </View>
                )}
            </View>

            {ghostImage && (
                <View style={[styles.sliderContainer, isLandscape && styles.sliderContainerLandscape]}>
                    <Ionicons name="contrast-outline" size={20} color="white" />
                    <Slider
                        style={isLandscape ? styles.sliderVertical : styles.sliderHorizontal}
                        minimumValue={0.0}
                        maximumValue={1.0}
                        value={ghostOpacity}
                        onValueChange={setGhostOpacity}
                        minimumTrackTintColor="#667B53"
                        maximumTrackTintColor="#FFFFFF"
                        thumbTintColor="#FFFFFF"
                    />
                </View>
            )}

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
    sliderContainer: {
        position: 'absolute',
        bottom: 140,
        left: 20,
        right: 20,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 20,
        paddingHorizontal: 15,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        zIndex: 20,
    },
    sliderContainerLandscape: {
        bottom: 20,
        top: 20,
        left: 20,
        right: 'auto',
        width: 60,
        paddingHorizontal: 10,
        paddingVertical: 15,
        flexDirection: 'column',
    },
    sliderHorizontal: {
        flex: 1,
        marginLeft: 10,
        height: 40,
    },
    sliderVertical: {
        width: 150,
        height: 40,
        marginTop: 65,
        transform: [{ rotate: '-90deg' }],
    },
    message: { color: 'white', textAlign: 'center', marginTop: 100 },
});
