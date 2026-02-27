console.log("[Supabase Lib] Initializing...");
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://qldnzdypjtdlzlglijty.supabase.co';
const supabaseKey = 'sb_publishable_sHyDlbUuK_FxxhV7SpRbkA_uQt5o9nj';

export const GOOGLE_DRIVE_FOLDERS = {
    2026: '19CLJl-7XgczFh8WYyTRPuBedyEvhP4Ox',
    // Future years can be added here
};

export const supabase = createClient(supabaseUrl, supabaseKey, {

    auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
    },
});

export const fetchNearestPhoto = async (latitude, longitude) => {
    try {
        const tolerance = 0.0002; // Approx 20 meters
        const minLat = latitude - tolerance;
        const maxLat = latitude + tolerance;
        const minLon = longitude - tolerance;
        const maxLon = longitude + tolerance;

        const { data, error } = await supabase
            .from('photos')
            .select('image_url')
            .gte('latitude', minLat)
            .lte('latitude', maxLat)
            .gte('longitude', minLon)
            .lte('longitude', maxLon)
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.error('Error fetching nearest photo:', error);
            return null;
        }

        if (data && data.length > 0) {
            return data[0].image_url;
        }
        return null;
    } catch (e) {
        console.error('Exception fetching nearest photo:', e);
        return null;
    }
};

export const fetchAllPhotoLocations = async () => {
    console.log("[Supabase] Fetching all photo locations...");
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Database fetch timed out")), 10000)
    );

    try {
        const fetchPromise = supabase
            .from('photos')
            .select('id, latitude, longitude, created_at, image_url')
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .order('created_at', { ascending: false });

        const { data, error } = await Promise.race([
            fetchPromise,
            timeoutPromise
        ]);

        if (error) {
            console.error('[Supabase] Error fetching photo locations:', error);
            return [];
        }
        console.log(`[Supabase] Successfully fetched ${data?.length || 0} photo locations`);
        return data;
    } catch (e) {
        console.error('[Supabase] Exception fetching photo locations:', e.message);
        return [];
    }
};

// Fetch all active cropping years
export const fetchCroppingYears = async () => {
    const { data, error } = await supabase
        .from('cropping_years')
        .select('*')
        .order('year', { ascending: false });

    if (error) {
        console.error("Error fetching cropping years:", error);
        return [];
    }
    return data;
};

// Fetch parcels for a specific year
export const fetchParcels = async (year) => {
    const { data, error } = await supabase
        .from('parcels')
        .select('*')
        .eq('year', year);

    if (error) {
        console.error("Error fetching parcels:", error);
        return [];
    }
    return data;
};

// Insert a batch of parcels (chunked for large datasets)
export const insertParcels = async (parcels) => {
    const CHUNK_SIZE = 100;
    const results = [];

    for (let i = 0; i < parcels.length; i += CHUNK_SIZE) {
        const chunk = parcels.slice(i, i + CHUNK_SIZE);
        const { data, error } = await supabase
            .from('parcels')
            .insert(chunk)
            .select();

        if (error) {
            console.error(`Error inserting parcel chunk ${i / CHUNK_SIZE}:`, error);
            throw error;
        }
        results.push(...(data || []));
    }
    return results;
};

// Migrates all parcels from 2025 to 2026 and sets 2026 as active
export const migrateParcelsTo2026 = async () => {
    // 1. Ensure 2026 exists
    const years = await fetchCroppingYears();
    if (!years.find(y => y.year === 2026)) {
        await insertCroppingYear(2026);
    }

    // 2. Move parcels from 2025 to 2026
    const { error: updateError } = await supabase
        .from('parcels')
        .update({ year: 2026 })
        .eq('year', 2025);

    if (updateError) {
        console.error("Error migrating parcels:", updateError);
        throw updateError;
    }

    // 3. Set 2026 active, others inactive
    await supabase.from('cropping_years').update({ is_active: false }).neq('year', 2026);
    await supabase.from('cropping_years').update({ is_active: true }).eq('year', 2026);

    return true;
};

// Deletes the years 2024 and 2025 (and cascade deletes their parcels)
export const deleteUnusedYears = async () => {
    const { error } = await supabase
        .from('cropping_years')
        .delete()
        .in('year', [2024, 2025]);

    if (error) {
        console.error("Error deleting old years:", error);
        throw error;
    }
    return true;
};
