import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');

export default function TimelapseScreen({ route }) {
    const { photos } = route.params;
    console.log('TimelapseScreen received photos:', photos?.length);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(true); // Auto-play
    const timerRef = useRef(null);

    // Ensure photos are sorted by date ascending for playback
    const sortedPhotos = React.useMemo(() => {
        return [...photos].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }, [photos]);

    const currentPhoto = sortedPhotos[currentIndex];

    useEffect(() => {
        // Force start on mount
        setIsPlaying(true);
        console.log('TimelapseScreen mounted, auto-play starting...');
    }, []);

    useEffect(() => {
        console.log('Timelapse Playback Effect:', { isPlaying, photosCount: sortedPhotos.length });
        if (isPlaying && sortedPhotos.length > 1) {
            timerRef.current = setInterval(() => {
                setCurrentIndex((prev) => (prev + 1) % sortedPhotos.length);
            }, 600);
        } else {
            clearInterval(timerRef.current);
        }
        return () => clearInterval(timerRef.current);
    }, [isPlaying, sortedPhotos.length]);

    const togglePlay = () => {
        setIsPlaying(prev => !prev);
    };

    if (!currentPhoto) return <View style={styles.container}><Text>No photos available</Text></View>;

    return (
        <View style={styles.container}>
            <Image
                source={{ uri: currentPhoto.image_url }}
                style={styles.image}
                contentFit="contain"
                transition={200}
                onLoad={() => console.log('Timelapse Image Loaded:', currentPhoto.image_url)}
                onError={(e) => console.log('Timelapse Image Error:', e.error, currentPhoto.image_url)}
            />

            <View style={styles.overlay}>
                <Text style={styles.dateText}>
                    {new Date(currentPhoto.created_at).toLocaleString()}
                </Text>
                <Text style={styles.counterText}>
                    {currentIndex + 1} / {sortedPhotos.length}
                </Text>
            </View>

            <View style={styles.controls}>
                <View style={styles.buttonRow}>
                    <TouchableOpacity onPress={() => setCurrentIndex(0)} style={styles.navButton}>
                        <Ionicons name="play-skip-back-circle" size={44} color="white" />
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setCurrentIndex(prev => Math.max(0, prev - 1))} style={styles.navButton}>
                        <Ionicons name="play-back-circle" size={44} color="white" />
                    </TouchableOpacity>

                    <TouchableOpacity onPress={togglePlay} style={styles.playButton}>
                        <Ionicons name={isPlaying ? "pause-circle" : "play-circle"} size={64} color="white" />
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setCurrentIndex(prev => Math.min(sortedPhotos.length - 1, prev + 1))} style={styles.navButton}>
                        <Ionicons name="play-forward-circle" size={44} color="white" />
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setCurrentIndex(sortedPhotos.length - 1)} style={styles.navButton}>
                        <Ionicons name="play-skip-forward-circle" size={44} color="white" />
                    </TouchableOpacity>
                </View>

                <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={sortedPhotos.length - 1}
                    step={1}
                    value={currentIndex}
                    onValueChange={setCurrentIndex}
                    minimumTrackTintColor="#FFFFFF"
                    maximumTrackTintColor="#666666"
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'black',
        justifyContent: 'center',
    },
    image: {
        width: width,
        height: '100%',
    },
    overlay: {
        position: 'absolute',
        top: 50,
        alignSelf: 'center', // Center horizontally
        backgroundColor: 'rgba(0, 0, 0, 0.6)', // Semi-transparent black background
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
        alignItems: 'center',
    },
    dateText: {
        color: 'white',
        fontSize: 20, // Slightly larger
        fontWeight: 'bold',
    },
    counterText: {
        color: 'white',
        fontSize: 14,
        marginTop: 5,
    },
    controls: {
        position: 'absolute',
        bottom: 40,
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    playButton: {
        marginHorizontal: 10,
    },
    buttonRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 10,
    },
    navButton: {
        marginHorizontal: 5,
    },
    slider: {
        width: '100%',
        height: 40,
    },
});
