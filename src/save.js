import { MODULE_NAME } from "../settings.js";
import { registerSavedImage } from "./cleanup.js";
import { fetchWithTimeout, transferTimeoutMs } from "./http.js";
import { notifyWarning } from "./notify.js";

// Sub-folder used when the chat has no resolvable character or group name.
const FALLBACK_FOLDER = "ComfyInject";

// Blob MIME types the upload endpoint accepts, mapped to its "format" field.
const MIME_TO_FORMAT = Object.freeze({
    "image/webp": "webp",
    "image/png":  "png",
    "image/jpeg": "jpg",
    "image/gif":  "gif",
});

/**
 * Gets the current ComfyInject settings from SillyTavern's extension settings.
 * @returns {object} The current settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

/**
 * Returns the sub-folder images are uploaded into.
 * Follows SillyTavern's own convention of one folder per character.
 * @returns {string} The folder name
 */
function getImageFolder() {
    const context = SillyTavern.getContext();

    if (context.groupId) {
        const group = context.groups?.find((candidate) => candidate.id === context.groupId);
        if (group?.name) return group.name;
    }

    return context.name2 || FALLBACK_FOLDER;
}

/**
 * Strips the extension off a ComfyUI filename so the upload endpoint can
 * append the real one. Remaining dots are flattened because the endpoint
 * only removes the last extension.
 * @param {string} filename - The ComfyUI filename, e.g. "ComfyInject_03864_.png"
 * @returns {string} The bare basename, e.g. "ComfyInject_03864_"
 */
function toBaseName(filename) {
    return String(filename).replace(/\.[^.]+$/, "").replace(/\./g, "_");
}

/**
 * Downloads the generated image from ComfyUI.
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @returns {Promise<Blob>} The raw image bytes
 */
async function fetchImageBlob(imageUrl) {
    const response = await fetchWithTimeout(imageUrl, {}, transferTimeoutMs());
    if (!response.ok) {
        throw new Error(`[ComfyInject] Failed to download image: ${response.status}`);
    }
    return await response.blob();
}

/**
 * Downscales an image to fit within maxDimension and re-encodes it to WebP.
 * Images already smaller than maxDimension are re-encoded but not enlarged.
 * @param {Blob} blob - The original image bytes
 * @param {number} maxDimension - Maximum width or height in pixels
 * @param {number} quality - WebP quality, 1-100
 * @returns {Promise<Blob>} The re-encoded image
 */
async function downscale(blob, maxDimension, quality) {
    const bitmap = await createImageBitmap(blob);

    try {
        const largest = Math.max(bitmap.width, bitmap.height);
        const scale = largest > maxDimension ? maxDimension / largest : 1;
        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);

        const encoded = await new Promise((resolve) => {
            canvas.toBlob(resolve, "image/webp", quality / 100);
        });

        if (!encoded) {
            throw new Error("[ComfyInject] Canvas returned no image data");
        }

        return encoded;
    } finally {
        bitmap.close();
    }
}

/**
 * Converts a blob to a bare base64 string (no data URL prefix).
 * @param {Blob} blob - The image bytes
 * @returns {Promise<string>} The base64 encoded image
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * Uploads the image to SillyTavern and returns the path it was saved to.
 * @param {string} base64 - The base64 encoded image
 * @param {string} format - One of the formats accepted by the upload endpoint
 * @param {string} filename - The filename without extension
 * @param {string} folder - The character sub-folder to save into
 * @returns {Promise<string>} The path SillyTavern serves the image from
 */
async function uploadImage(base64, format, filename, folder) {
    const { getRequestHeaders } = SillyTavern.getContext();

    const response = await fetchWithTimeout("/api/images/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: base64, format, filename, ch_name: folder }),
    }, transferTimeoutMs());

    if (!response.ok) {
        throw new Error(`[ComfyInject] Failed to upload image: ${response.status}`);
    }

    const data = await response.json();

    if (!data.path) {
        throw new Error(`[ComfyInject] Upload response missing path`);
    }

    return data.path;
}

/**
 * Copies a freshly generated image into SillyTavern's own image storage so
 * the message does not have to hotlink back to ComfyUI.
 *
 * Any failure falls back to the original ComfyUI URL — a failed save must
 * never cost the user their image.
 *
 * @param {string} imageUrl - The full ComfyUI /view URL
 * @param {string} filename - The ComfyUI filename from pollForResult
 * @returns {Promise<string>} The local path, or the original URL on failure
 */
export async function saveImageLocally(imageUrl, filename) {
    const settings = getSettings();

    if (!settings.save_images_locally) return imageUrl;

    try {
        let blob = await fetchImageBlob(imageUrl);

        if (settings.downscale_before_saving) {
            try {
                blob = await downscale(
                    blob,
                    settings.downscale_max_dimension ?? 1280,
                    settings.webp_quality ?? 82
                );
            } catch (err) {
                // Saving the full-size original is still much better than hotlinking
                console.warn(`[ComfyInject] Could not downscale image, saving the original:`, err);
            }
        }

        const format = MIME_TO_FORMAT[blob.type];
        if (!format) {
            throw new Error(`[ComfyInject] Unsupported image type: ${blob.type}`);
        }

        const path = await uploadImage(
            await blobToBase64(blob),
            format,
            toBaseName(filename),
            getImageFolder()
        );

        // Recorded so the image can be removed along with its chat
        registerSavedImage(path);

        console.log(`[ComfyInject] Image saved to SillyTavern: ${path}`);
        return path;
    } catch (err) {
        console.error(`[ComfyInject] Could not save image to SillyTavern, keeping the ComfyUI link:`, err);
        // The user still has their image, so this notice obeys repair_toast_mode.
        notifyWarning("Could not save the image to SillyTavern. Using the ComfyUI link instead.");
        return imageUrl;
    }
}
