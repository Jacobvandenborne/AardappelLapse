import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = 'offline_queue';
const PHOTOS_DIR = FileSystem.documentDirectory + 'photos/';

// Ensure photos directory exists
const ensureDirExists = async () => {
    const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
    if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
    }
};

export const saveToQueue = async (uri, location) => {
    try {
        await ensureDirExists();
        const fileName = uri.split('/').pop();
        const newPath = PHOTOS_DIR + fileName;

        // Move file to permanent storage
        await FileSystem.moveAsync({
            from: uri,
            to: newPath,
        });

        // Create metadata entry
        const newItem = {
            id: Date.now().toString(),
            uri: newPath,
            location,
            timestamp: Date.now(),
        };

        // Update AsyncStorage
        const existingQueueConfig = await AsyncStorage.getItem(QUEUE_KEY);
        let queue = existingQueueConfig ? JSON.parse(existingQueueConfig) : [];
        queue.push(newItem);
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

        console.log('Saved to offline queue:', newItem);
        return queue.length;
    } catch (error) {
        console.error('Error saving to queue:', error);
        throw error;
    }
};

export const getQueue = async () => {
    try {
        const queueConfig = await AsyncStorage.getItem(QUEUE_KEY);
        return queueConfig ? JSON.parse(queueConfig) : [];
    } catch (error) {
        console.error('Error getting queue:', error);
        return [];
    }
};

export const removeFromQueue = async (id) => {
    try {
        // 1. Get current queue
        const queue = await getQueue();
        const itemToRemove = queue.find(item => item.id === id);

        if (!itemToRemove) return;

        // 2. Remove file (optional: keep it if you want a local gallery, 
        // but typically we clean up after upload to save space)
        // For now, let's keep it safe and ONLY remove from queue list, 
        // or we can delete the file:
        await FileSystem.deleteAsync(itemToRemove.uri, { idempotent: true });

        // 3. Update queue
        const newQueue = queue.filter(item => item.id !== id);
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(newQueue));

        console.log('Removed from queue:', id);
        return newQueue.length;
    } catch (error) {
        console.error('Error removing from queue:', error);
    }
};
