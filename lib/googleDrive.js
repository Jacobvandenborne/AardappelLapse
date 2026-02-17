import { supabase } from './supabase';

/**
 * Utility to interact with Google Drive API
 */
export const GoogleDrive = {
    /**
     * Get the provider token from the current session
     */
    async getProviderToken() {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error || !session) return null;
        return session.provider_token;
    },

    /**
     * Search for or create the 'AardappelLapse' folder
     */
    async getOrCreateFolder(token) {
        try {
            // 1. Search for existing folder
            const query = encodeURIComponent("name = 'AardappelLapse' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
            const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const searchData = await searchResp.json();

            if (searchData.files && searchData.files.length > 0) {
                return searchData.files[0].id;
            }

            // 2. Create if not exists
            const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'AardappelLapse',
                    mimeType: 'application/vnd.google-apps.folder'
                })
            });
            const createData = await createResp.json();
            return createData.id;
        } catch (error) {
            console.error("[GoogleDrive] Error getOrCreateFolder:", error);
            return null;
        }
    },

    /**
     * List zip files in the AardappelLapse folder or globally
     */
    async listFiles(parentFolderId = 'root') {
        try {
            const token = await this.getProviderToken();
            if (!token) return [];

            // Query: files in the specific parent folder that are either folders OR zip files
            const folderMime = 'application/vnd.google-apps.folder';
            const zipMimes = "mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed' or name contains '.zip'";
            const query = encodeURIComponent(`'${parentFolderId}' in parents and (mimeType = '${folderMime}' or ${zipMimes}) and trashed = false`);

            const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=folder,name`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json();
            return data.files || [];
        } catch (error) {
            console.error("[GoogleDrive] listFiles Error:", error);
            return [];
        }
    },

    /**
     * Download a file's content as ArrayBuffer
     */
    async downloadFile(fileId) {
        try {
            const token = await this.getProviderToken();
            if (!token) return null;

            const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!response.ok) throw new Error("Google Drive download failed");

            const buffer = await response.arrayBuffer();
            return buffer;
        } catch (error) {
            console.error("[GoogleDrive] downloadFile Error:", error);
            return null;
        }
    },

    /**
     * Upload a file to the AardappelLapse folder
     */
    async uploadFile(fileName, mimeType, base64Data) {
        try {
            const token = await this.getProviderToken();
            if (!token) {
                console.warn("[GoogleDrive] No provider token found. User may need to re-log.");
                return null;
            }

            const folderId = await this.getOrCreateFolder(token);
            if (!folderId) return null;

            // Multipart upload
            const metadata = {
                name: fileName,
                parents: [folderId]
            };

            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const body =
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                `Content-Type: ${mimeType}\r\n` +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                base64Data +
                close_delim;

            const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: body
            });

            const result = await response.json();
            return result.id;
        } catch (error) {
            console.error("[GoogleDrive] Upload File Error:", error);
            return null;
        }
    }
};
