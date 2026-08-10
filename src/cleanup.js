import { MODULE_NAME } from "../settings.js";

// SillyTavern deletes only the .jsonl when a chat is removed, and CHAT_DELETED
// fires after the file is already gone — so the chat can no longer be asked
// which images it used. ComfyInject therefore writes down every image it saves
// against the chat that generated it, in extension settings, which is the only
// store that outlives the chat file.
//
// The registry records ownership, never permission: an image is only deleted
// once the surviving chats have been read and none of them still reference it.
// That ordering means a stale registry can at worst leave a file behind, never
// remove one that is still on screen.
const REGISTRY_KEY = "saved_images";

// Any path into SillyTavern's own image storage, however it is quoted.
const LOCAL_IMAGE_REGEX = /\/user\/images\/[^"'\s)<>]+/g;

/**
 * Gets the current ComfyInject settings from SillyTavern's extension settings.
 * @returns {object} The current settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

/**
 * Returns the mutable registry of saved images, keyed by chat id.
 *
 * Deliberately absent from defaultSettings: the Reset button assigns the
 * defaults over the settings object, so a key that is not a default survives
 * a reset instead of orphaning every image ComfyInject has ever saved.
 *
 * @returns {Record<string, {avatar: string|null, groupId: string|null, paths: string[]}>} The registry
 */
function getRegistry() {
    const settings = getSettings();

    if (!settings[REGISTRY_KEY] || typeof settings[REGISTRY_KEY] !== "object") {
        settings[REGISTRY_KEY] = {};
    }

    return settings[REGISTRY_KEY];
}

/**
 * Strips the extension off a chat file name.
 * Chat ids carry no extension, but CHAT_RENAMED reports both names with
 * ".jsonl" attached, so every id is normalized on the way in.
 * @param {string} value - A chat id or chat file name
 * @returns {string} The chat id
 */
function toChatId(value) {
    return String(value ?? "").replace(/\.jsonl$/, "");
}

/**
 * Returns the bare file name of an image path.
 * @param {string} imagePath - A stored image path
 * @returns {string} The file name
 */
function fileNameOf(imagePath) {
    return String(imagePath).split("/").pop();
}

/**
 * Reads or creates the registry entry for a chat.
 * @param {object} registry - The registry
 * @param {string} chatId - The chat id
 * @returns {{avatar: string|null, groupId: string|null, paths: string[]}} The entry
 */
function entryFor(registry, chatId) {
    const entry = registry[chatId] ?? {};

    if (!Array.isArray(entry.paths)) {
        entry.paths = [];
    }

    registry[chatId] = entry;
    return entry;
}

/**
 * Records that ComfyInject saved an image for the current chat, so the image
 * can be cleaned up if that chat is ever deleted.
 *
 * @param {string} imagePath - The path returned by the upload endpoint
 */
export function registerSavedImage(imagePath) {
    const context = SillyTavern.getContext();
    const chatId = toChatId(context.getCurrentChatId());

    if (!chatId) {
        console.warn(`[ComfyInject] No active chat, ${imagePath} will not be cleaned up automatically`);
        return;
    }

    const registry = getRegistry();
    const entry = entryFor(registry, chatId);

    // Refreshed on every save so the owner stays correct even if the entry
    // was written by an older version that did not record it.
    entry.groupId = context.groupId || null;
    entry.avatar = entry.groupId ? null : context.characters?.[context.characterId]?.avatar ?? null;

    if (!entry.paths.includes(imagePath)) {
        entry.paths.push(imagePath);
    }

    context.saveSettingsDebounced();
}

/**
 * Lists the chats that still exist for whoever owns a registry entry.
 * An empty query makes the search endpoint return every chat.
 * @param {{avatar: string|null, groupId: string|null}} entry - The registry entry
 * @returns {Promise<string[]>} The surviving chat ids
 */
async function listSurvivingChats(entry) {
    const { getRequestHeaders } = SillyTavern.getContext();

    const response = await fetch("/api/chats/search", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            query: "",
            avatar_url: entry.groupId ? null : entry.avatar,
            group_id: entry.groupId || null,
        }),
    });

    if (!response.ok) {
        throw new Error(`[ComfyInject] Could not list chats: ${response.status}`);
    }

    const results = await response.json();

    if (!Array.isArray(results)) return [];

    return results.map((result) => toChatId(result.file_name)).filter(Boolean);
}

/**
 * Fetches one chat's messages.
 * @param {string} chatId - The chat id
 * @param {{avatar: string|null, groupId: string|null}} entry - The registry entry
 * @returns {Promise<any>} The chat as the server returns it
 */
async function fetchChat(chatId, entry) {
    const { getRequestHeaders } = SillyTavern.getContext();

    const url = entry.groupId ? "/api/chats/group/get" : "/api/chats/get";
    const body = entry.groupId
        ? { id: chatId }
        : { avatar_url: entry.avatar, file_name: chatId };

    const response = await fetch(url, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`[ComfyInject] Could not read chat "${chatId}": ${response.status}`);
    }

    return await response.json();
}

/**
 * Records every locally stored image referenced anywhere inside a chat.
 *
 * Walking every string rather than reading known fields is deliberate: an
 * image can sit in the visible text, in any swipe the user can flip back to,
 * in extra.image, or in the nested message snapshots kept for continuations.
 * Missing one of those would delete an image that is still reachable.
 *
 * @param {any} value - Any part of a fetched chat
 * @param {Map<string, string>} into - File name to the chat that references it
 * @param {string} chatId - The chat being scanned
 */
function collectImageReferences(value, into, chatId) {
    if (typeof value === "string") {
        for (const match of value.matchAll(LOCAL_IMAGE_REGEX)) {
            const filename = fileNameOf(match[0]);
            if (!into.has(filename)) into.set(filename, chatId);
        }
    } else if (Array.isArray(value)) {
        value.forEach((entry) => collectImageReferences(entry, into, chatId));
    } else if (value && typeof value === "object") {
        Object.values(value).forEach((entry) => collectImageReferences(entry, into, chatId));
    }
}

/**
 * Builds the set of images still referenced by any surviving chat.
 * @param {{avatar: string|null, groupId: string|null}} entry - The registry entry
 * @param {string} deletedChatId - The chat that was just deleted
 * @returns {Promise<Map<string, string>>} File name to the chat still using it
 */
async function collectSurvivingReferences(entry, deletedChatId) {
    const references = new Map();

    for (const chatId of await listSurvivingChats(entry)) {
        // The deleted chat's file is already gone, but never count it anyway
        if (chatId === deletedChatId) continue;

        collectImageReferences(await fetchChat(chatId, entry), references, chatId);
    }

    return references;
}

/**
 * Deletes one image from SillyTavern's storage.
 * @param {string} imagePath - The stored image path
 */
async function deleteImage(imagePath) {
    const { getRequestHeaders } = SillyTavern.getContext();

    const response = await fetch("/api/images/delete", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: imagePath }),
    });

    // A missing file is already the desired end state
    if (!response.ok && response.status !== 404) {
        throw new Error(`[ComfyInject] Image delete failed: ${response.status}`);
    }
}

/**
 * Hands an image over to a chat that still shows it, so it stays eligible for
 * cleanup when that chat is deleted in turn.
 * @param {object} registry - The registry
 * @param {string} chatId - The chat that still references the image
 * @param {{avatar: string|null, groupId: string|null}} previous - The entry being retired
 * @param {string} imagePath - The stored image path
 */
function adoptImage(registry, chatId, previous, imagePath) {
    const entry = entryFor(registry, chatId);

    entry.avatar = entry.avatar ?? previous.avatar;
    entry.groupId = entry.groupId ?? previous.groupId;

    if (!entry.paths.includes(imagePath)) {
        entry.paths.push(imagePath);
    }
}

/**
 * Deletes the images a chat owned, now that the chat itself is gone.
 * @param {string} rawChatId - The chat id from the deletion event
 */
async function deleteImagesForChat(rawChatId) {
    const chatId = toChatId(rawChatId);
    const registry = getRegistry();
    const entry = registry[chatId];

    if (!entry) return;

    const paths = Array.isArray(entry.paths) ? entry.paths : [];

    if (!getSettings().delete_images_with_chat || paths.length === 0) {
        delete registry[chatId];
        SillyTavern.getContext().saveSettingsDebounced();
        return;
    }

    // Without an owner the surviving chats cannot be found, and the chat
    // endpoints would take a null avatar literally and create a "null" folder.
    if (!entry.groupId && !entry.avatar) {
        console.warn(`[ComfyInject] Skipped image cleanup for "${chatId}", its owner was never recorded`);
        return;
    }

    let references;

    try {
        references = await collectSurvivingReferences(entry, chatId);
    } catch (err) {
        // Without a complete picture of what is still in use, deleting
        // anything risks removing an image another chat still shows. Keep the
        // entry too, so the record of these files is not lost.
        console.error("[ComfyInject] Skipped image cleanup, could not verify what is still in use:", err);
        return;
    }

    let deleted = 0;

    for (const imagePath of paths) {
        const stillUsedBy = references.get(fileNameOf(imagePath));

        if (stillUsedBy) {
            adoptImage(registry, stillUsedBy, entry, imagePath);
            console.log(`[ComfyInject] Keeping ${imagePath}, still used by "${stillUsedBy}"`);
            continue;
        }

        try {
            await deleteImage(imagePath);
            deleted++;
        } catch (err) {
            console.error(`[ComfyInject] Could not delete ${imagePath}:`, err);
        }
    }

    delete registry[chatId];
    SillyTavern.getContext().saveSettingsDebounced();

    if (deleted > 0) {
        console.log(`[ComfyInject] Deleted ${deleted} image(s) belonging to "${chatId}"`);
    }
}

/**
 * Moves a chat's registry entry to its new name.
 * @param {object} data - The CHAT_RENAMED payload
 */
function renameChatEntry(data) {
    const oldId = toChatId(data?.oldFileName);
    const newId = toChatId(data?.newFileName);

    if (!oldId || !newId || oldId === newId) return;

    const registry = getRegistry();

    if (!registry[oldId]) return;

    registry[newId] = registry[oldId];
    delete registry[oldId];

    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Starts tracking chat deletions and renames so saved images follow the chat
 * they belong to.
 */
export function initCleanup() {
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.CHAT_DELETED, deleteImagesForChat);
    eventSource.on(event_types.GROUP_CHAT_DELETED, deleteImagesForChat);
    eventSource.on(event_types.CHAT_RENAMED, renameChatEntry);

    console.log("[ComfyInject] Image cleanup listener initialized");
}
