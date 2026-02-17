import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, Alert, TouchableOpacity, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import MapView, { Marker, UrlTile, Circle, Polygon, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { useFocusEffect } from '@react-navigation/native';
import { fetchAllPhotoLocations, fetchParcels, fetchCroppingYears } from '../lib/supabase';
import { Ionicons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');

// Helper to calculate distance in meters
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

export default function MapScreen({ navigation }) {
    const [location, setLocation] = useState(null);
    const [clusters, setClusters] = useState([]);
    const [parcels, setParcels] = useState([]);
    const [calloutIndex, setCalloutIndex] = useState({});
    const [activeClusterId, setActiveClusterId] = useState(null);
    const mapRef = useRef(null);

    // Refresh data when screen is focused
    useFocusEffect(
        React.useCallback(() => {
            const refreshData = async () => {
                console.log("[Map] Screen focused, refreshing data...");

                // Fetch photos
                const photoData = await fetchAllPhotoLocations();
                clusterPhotos(photoData || []);

                // Fetch parcels for active year
                const years = await fetchCroppingYears();
                const activeYear = years.find(y => y.is_active);
                if (activeYear) {
                    const parcelData = await fetchParcels(activeYear.year);
                    console.log(`[Map] Fetched ${parcelData.length} parcels for ${activeYear.year}`);
                    setParcels(parcelData || []);
                }
            };
            refreshData();
        }, [])
    );

    useEffect(() => {
        (async () => {
            console.log("[Map] Requesting permissions...");
            const { status } = await Promise.race([
                Location.requestForegroundPermissionsAsync(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Permission request timed out")), 5000))
            ]);
            if (status !== 'granted') {
                console.warn("[Map] Location permission not granted");
                return;
            }

            console.log("[Map] Fetching current position...");
            // Use a faster/lower accuracy fallback if needed, or just a timeout
            try {
                let currentLocation = await Promise.race([
                    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Location timeout")), 10000))
                ]);
                console.log("[Map] Position found");
                setLocation(currentLocation);

                // Auto-zoom to user location on mount
                if (mapRef.current) {
                    mapRef.current.animateToRegion({
                        latitude: currentLocation.coords.latitude,
                        longitude: currentLocation.coords.longitude,
                        latitudeDelta: 0.01,
                        longitudeDelta: 0.01,
                    });
                }
            } catch (e) {
                console.warn("[Map] Could not get location quickly:", e.message);
                // Fallback: stay at initial region or show error
            }
        })();
    }, []);

    // Animation logic for the Bottom Sheet (Mini-Timelapse)
    useEffect(() => {
        if (!activeClusterId) return;

        const cluster = clusters.find(c => c.id === activeClusterId);
        if (!cluster || cluster.photos.length <= 1) return;

        const interval = setInterval(() => {
            setCalloutIndex(prev => ({
                ...prev,
                [activeClusterId]: ((prev[activeClusterId] || 0) + 1) % cluster.photos.length
            }));
        }, 1500);

        return () => clearInterval(interval);
    }, [activeClusterId, clusters]);

    const clusterPhotos = (photos) => {
        console.log(`[Map] Clustering ${photos.length} photos...`);
        const start = Date.now();
        const DISTANCE_THRESHOLD = 0.0002; // Approx 20 meters
        const newClusters = [];

        photos.forEach((photo) => {
            let added = false;
            for (let cluster of newClusters) {
                const latDiff = Math.abs(photo.latitude - cluster.latitude);
                const lonDiff = Math.abs(photo.longitude - cluster.longitude);

                if (latDiff < DISTANCE_THRESHOLD && lonDiff < DISTANCE_THRESHOLD) {
                    cluster.photos.push(photo);
                    if (new Date(photo.created_at) > new Date(cluster.latestPhoto.created_at)) {
                        cluster.latestPhoto = photo;
                    }
                    added = true;
                    break;
                }
            }

            if (!added) {
                newClusters.push({
                    id: photo.id,
                    latitude: photo.latitude,
                    longitude: photo.longitude,
                    photos: [photo],
                    latestPhoto: photo
                });
            }
        });

        setClusters(newClusters);
        console.log(`[Map] Clustering complete. Found ${newClusters.length} clusters in ${Date.now() - start}ms`);
    };

    const handleAddPhoto = (ghostImageUrl) => {
        navigation.navigate('Camera', {
            screen: 'Camera',
            params: { ghostImage: ghostImageUrl }
        });
    };

    const zoomToParcels = () => {
        if (!parcels || parcels.length === 0) return;

        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

        parcels.forEach(p => {
            const coords = p.geometry.geometry.coordinates;
            // Handle Polygon (coordinates[0]) or MultiPolygon
            const flatCoords = p.geometry.geometry.type === 'Polygon' ? coords[0] : coords.flat(2);
            flatCoords.forEach(c => {
                const [lon, lat] = c;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
            });
        });

        if (mapRef.current) {
            mapRef.current.animateToRegion({
                latitude: (minLat + maxLat) / 2,
                longitude: (minLon + maxLon) / 2,
                latitudeDelta: Math.abs(maxLat - minLat) * 1.5,
                longitudeDelta: Math.abs(maxLon - minLon) * 1.5,
            });
        }
    };

    const selectedCluster = clusters.find(c => c.id === activeClusterId);

    // Proximity check: Is the user within 20 meters of the selected cluster?
    const isNearby = selectedCluster && location ?
        getDistance(
            location.coords.latitude, location.coords.longitude,
            selectedCluster.latitude, selectedCluster.longitude
        ) <= 20 : false;

    return (
        <View style={styles.container}>
            <MapView
                ref={mapRef}
                style={styles.map}
                provider={PROVIDER_GOOGLE}
                initialRegion={{
                    latitude: 52.1326,
                    longitude: 5.2913,
                    latitudeDelta: 0.0922,
                    longitudeDelta: 0.0421,
                }}
                showsUserLocation={true}
                mapType="standard"
                onPress={() => setActiveClusterId(null)}
            >
                <UrlTile
                    urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                    shouldReplaceMapContent={true}
                    maximumZ={19}
                    tileSize={256}
                />

                {parcels.map((parcel) => (
                    <Polygon
                        key={parcel.id}
                        coordinates={parcel.geometry.geometry.type === 'Polygon'
                            ? parcel.geometry.geometry.coordinates[0].map(c => ({ longitude: c[0], latitude: c[1] }))
                            : [] // Simple polygon support for now
                        }
                        strokeColor="#667B53"
                        fillColor="rgba(102, 123, 83, 0.3)"
                        strokeWidth={2}
                    />
                ))}

                {clusters.map((cluster) => (
                    <Marker
                        key={cluster.id}
                        coordinate={{
                            latitude: cluster.latitude,
                            longitude: cluster.longitude,
                        }}
                        onPress={(e) => {
                            e.stopPropagation();
                            setActiveClusterId(cluster.id);
                        }}
                    >
                        <View style={[styles.customMarker, activeClusterId === cluster.id && styles.activeMarker]}>
                            <Image
                                source={{ uri: cluster.latestPhoto.image_url }}
                                style={styles.markerImage}
                                contentFit="cover"
                            />
                        </View>
                    </Marker>
                ))}
            </MapView>

            <TouchableOpacity style={styles.fab} onPress={zoomToParcels}>
                <Ionicons name="map" size={24} color="white" />
            </TouchableOpacity>

            {/* Bottom Sheet Detail View */}
            {selectedCluster && (
                <View style={styles.bottomSheet}>
                    <View style={styles.sheetHeader}>
                        <View>
                            <Text style={styles.sheetTitle}>LOCATIE DETAILS</Text>
                            {selectedCluster.photos[calloutIndex[selectedCluster.id] || 0]?.parcel_name && (
                                <Text style={styles.sheetSubtitle}>{selectedCluster.photos[calloutIndex[selectedCluster.id] || 0].parcel_name.toUpperCase()}</Text>
                            )}
                        </View>
                        <TouchableOpacity onPress={() => setActiveClusterId(null)}>
                            <Ionicons name="close-circle" size={28} color="#667B53" />
                        </TouchableOpacity>
                    </View>

                    <View style={styles.sheetContent}>
                        <View style={styles.sheetImageContainer}>
                            <Image
                                source={{ uri: selectedCluster.photos[calloutIndex[selectedCluster.id] || 0]?.image_url }}
                                style={styles.sheetImage}
                                contentFit="cover"
                                transition={300}
                            />
                            <View style={styles.sheetDateBadge}>
                                <Text style={styles.sheetDateText}>
                                    {new Date(selectedCluster.photos[calloutIndex[selectedCluster.id] || 0]?.created_at).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
                                </Text>
                            </View>
                        </View>

                        <View style={styles.sheetButtons}>
                            <TouchableOpacity
                                style={[styles.sheetBtn, styles.timelapseBtn]}
                                onPress={() => navigation.navigate('Timelapse', { photos: selectedCluster.photos })}
                            >
                                <Ionicons name="play" size={20} color="white" />
                                <Text style={styles.btnText}>Bekijk Timelapse</Text>
                            </TouchableOpacity>

                            {isNearby ? (
                                <TouchableOpacity
                                    style={[styles.sheetBtn, styles.addPhotoBtn]}
                                    onPress={() => handleAddPhoto(selectedCluster.latestPhoto.image_url)}
                                >
                                    <Ionicons name="camera" size={20} color="white" />
                                    <Text style={styles.btnText}>+ Foto Toevoegen</Text>
                                </TouchableOpacity>
                            ) : (
                                <View style={[styles.sheetBtn, styles.disabledBtn]}>
                                    <Text style={styles.disabledText}>Ga dichterbij om foto toe te voegen</Text>
                                </View>
                            )}
                        </View>
                    </View>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    map: { width: '100%', height: '100%' },
    customMarker: {
        width: 60, height: 45,
        borderRadius: 4,
        borderWidth: 2, borderColor: 'white',
        backgroundColor: '#B7D098', // Light Green
        overflow: 'hidden',
        elevation: 5,
        justifyContent: 'center',
        alignItems: 'center',
    },
    activeMarker: {
        borderColor: '#667B53', // Brand Green
        borderWidth: 3,
        width: 70, height: 52,
        borderRadius: 6,
        justifyContent: 'center',
        alignItems: 'center',
    },
    markerImage: {
        width: 60, // Swapped from height to fill box after 270 rotation
        height: 80,
        transform: [{ rotate: '270deg' }]
    },
    bottomSheet: {
        position: 'absolute',
        bottom: 25, left: 15, right: 15,
        backgroundColor: '#F7EEE3', // Kiezel
        borderRadius: 15,
        padding: 15,
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.2,
        shadowRadius: 10,
        borderWidth: 1,
        borderColor: '#D0A367', // Light Brown border
    },
    sheetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
    },
    sheetTitle: {
        fontSize: 16,
        fontFamily: 'Montserrat-Bold',
        color: '#000000',
        letterSpacing: 1.5,
    },
    sheetSubtitle: {
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        color: '#667B53',
        marginTop: 2,
        letterSpacing: 1,
    },
    sheetContent: { flexDirection: 'row', height: 130 },
    sheetImageContainer: {
        width: 173, height: 130, // 4:3 landscape
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#f0f0f0',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sheetImage: {
        width: 130, // Swapped to fill 173x130 after 270 rotation
        height: 173,
        transform: [{ rotate: '270deg' }]
    },
    sheetDateBadge: {
        position: 'absolute',
        bottom: 5, left: 5, right: 5,
        backgroundColor: 'rgba(60, 73, 58, 0.8)', // Dark Green transparent
        borderRadius: 4, padding: 3,
    },
    sheetDateText: {
        color: 'white',
        fontSize: 9,
        fontFamily: 'Montserrat-Bold',
        textAlign: 'center'
    },
    sheetButtons: {
        flex: 1, marginLeft: 15,
        justifyContent: 'space-around',
    },
    sheetBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        borderRadius: 8,
    },
    timelapseBtn: { backgroundColor: '#3C493A' }, // Dark Green
    addPhotoBtn: { backgroundColor: '#667B53' }, // Brand Green
    disabledBtn: { backgroundColor: '#D0A367', opacity: 0.5 },
    disabledText: {
        color: 'white',
        fontSize: 10,
        fontFamily: 'Montserrat-SemiBold',
        textAlign: 'center',
        paddingHorizontal: 5
    },
    btnText: {
        color: 'white',
        fontFamily: 'Montserrat-Bold',
        fontSize: 12,
        marginLeft: 8,
        letterSpacing: 0.5,
    },
    fab: {
        position: 'absolute',
        bottom: 30,
        right: 20,
        backgroundColor: '#3C493A',
        width: 56, height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
    }
});
