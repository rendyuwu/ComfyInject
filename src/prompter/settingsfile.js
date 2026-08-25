// Prompter settings file interchange — the Save Settings / Load Settings tools.
//
// This module deliberately touches no SillyTavern state: serialize and parse
// are pure text functions, so they stay node-smoke-testable like tags.js and
// schema.js. The browser-file half is still SillyTavern-free too — it only
// needs window, the File System Access API and IndexedDB.
//
// The file format is a header comment block followed by one `## <setting key>`
// section per prose field, the value in a ``` fence. Prose stays raw — no JSON
// escaping — so the file is comfortable to edit in an IDE and comfortable for
// an LLM to edit. The header is the exact settings key, so there is no label
// map to drift. The caller decides which keys are known; this parser returns
// every fenced section it finds.

export const PROMPTER_FILE_SUGGESTED_NAME = "comfyinject-prompter.txt";

const PROMPTER_FILE_HEADER = `# ComfyInject Prompter Settings
# Format: comfyinject-prompter/v1
#
# Edit freely, then "Load Settings" in the extension panel applies this file.
# Each section is a line "## <setting key>" followed by the value in a \`\`\` fence.
# Lines before the first section and sections with unknown keys are ignored.
# A section value must not contain a line that is exactly "\`\`\`".
`;

/**
 * Serializes an ordered list of prompter prose fields into the interchange
 * file. The caller passes the fields in a stable order (the PROMPTER_FIELDS
 * order) so a saved file diffs cleanly against the previous save.
 * @param {Array<{key: string, value: string}>} sections
 * @returns {string}
 */
export function serializePrompterFile(sections) {
    const body = sections
        .map(({ key, value }) => `## ${key}\n\`\`\`\n${value}\n\`\`\`\n\n`)
        .join("");
    return PROMPTER_FILE_HEADER + body;
}

/**
 * Parses the interchange file back into a { key: value } map. Every fenced
 * section is returned, unknown keys included. Content between the fences is
 * kept verbatim (nothing is trimmed), so an empty value parses as "" and the
 * round-trip is lossless. A "## " line inside a fence is content, never a new
 * section; a section left unterminated at EOF is dropped rather than
 * half-applied.
 * @param {string} text
 * @returns {Object<string, string>}
 */
export function parsePrompterFile(text) {
    const sections = {};
    let key = null;
    let buf = null;         // null = outside a section; otherwise collecting content
    let expectOpen = false; // the line after a header is its opening fence
    for (const line of text.split("\n")) {
        if (expectOpen) {
            expectOpen = false;
            buf = line === "```" ? [] : [line];
        } else if (buf !== null) {
            if (line === "```") {
                sections[key] = buf.join("\n");
                key = null;
                buf = null;
            } else {
                buf.push(line);
            }
        } else {
            const match = line.match(/^## (\S+)$/);
            if (match) {
                key = match[1];
                expectOpen = true;
            }
        }
    }
    return sections;
}

// --- Browser file IO ---------------------------------------------------------
//
// Primary path is the File System Access API (Chromium): the user picks a file
// once and the handle is remembered in IndexedDB, so later saves and loads
// reuse it without another picker. Where the API is missing (Firefox, Safari),
// save becomes a download and load becomes a hidden file input. A remembered
// handle that has gone stale (the file was moved or deleted) is forgotten and
// the user is asked to pick again. A cancelled picker rejects with AbortError,
// which the caller swallows silently.

const HANDLE_DB_NAME = "comfyinject";
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = "files";
const HANDLE_KEY = "prompter-settings";

/** @returns {Promise<IDBDatabase|null>} null when IndexedDB is unavailable. */
function openHandleDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
            request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

/** @returns {Promise<FileSystemFileHandle|null>} */
async function getStoredHandle() {
    const db = await openHandleDb();
    if (!db) return null;
    return new Promise((resolve) => {
        const transaction = db.transaction(HANDLE_STORE, "readonly");
        const request = transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
    });
}

/** Remembers a picked handle so the next save/load skips the picker. */
async function storeHandle(handle) {
    const db = await openHandleDb();
    if (!db) return;
    await new Promise((resolve) => {
        const transaction = db.transaction(HANDLE_STORE, "readwrite");
        transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
    });
}

/** Forgets a handle whose file has gone stale. */
async function forgetHandle() {
    const db = await openHandleDb();
    if (!db) return;
    await new Promise((resolve) => {
        const transaction = db.transaction(HANDLE_STORE, "readwrite");
        transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
    });
}

/**
 * Resolves a handle usable for the given mode, asking the user for permission
 * when a previously-picked handle needs it re-granted.
 * @param {FileSystemFileHandle} handle
 * @param {"read"|"readwrite"} mode
 * @returns {Promise<FileSystemFileHandle|null>}
 */
async function handleWithPermission(handle, mode) {
    if (!handle) return null;
    try {
        if (handle.queryPermission) {
            const state = await handle.queryPermission({ mode });
            if (state === "granted") return handle;
            if (state === "prompt" && handle.requestPermission) {
                const granted = await handle.requestPermission({ mode });
                if (granted === "granted") return handle;
            }
            return null;
        }
        return handle;
    } catch {
        return null;
    }
}

/** @returns {Promise<void>} */
async function writeHandle(handle, text) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
}

const FILE_TYPES = [{ description: "ComfyInject prompter settings", accept: { "text/plain": [".txt"] } }];

/**
 * Writes the serialized file. Resolves normally on success; rejects with
 * AbortError when the user dismisses the picker.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function savePrompterSettingsFile(text) {
    if (window.showSaveFilePicker) {
        const stored = await getStoredHandle();
        let handle = stored ? await handleWithPermission(stored, "readwrite") : null;
        if (handle) {
            try {
                await writeHandle(handle, text);
                return;
            } catch (err) {
                if (err?.name === "AbortError") throw err;
                // A remembered handle goes stale when the file is moved or
                // deleted; forget it and let the user pick a new location.
                await forgetHandle();
            }
        }
        handle = await window.showSaveFilePicker({
            suggestedName: PROMPTER_FILE_SUGGESTED_NAME,
            types: FILE_TYPES,
        });
        await writeHandle(handle, text);
        await storeHandle(handle);
        return;
    }

    // Fallback: download the file like any other browser download.
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = PROMPTER_FILE_SUGGESTED_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads the interchange file back. Resolves with the file text, or null when
 * the user dismisses the picker without choosing. Rejects with AbortError only
 * when a fallback path cannot reach a picker at all — the caller should treat
 * any other rejection as an error toast.
 * @returns {Promise<string|null>}
 */
export async function loadPrompterSettingsFile() {
    if (window.showOpenFilePicker) {
        const stored = await getStoredHandle();
        let handle = stored ? await handleWithPermission(stored, "read") : null;
        if (handle) {
            try {
                return await (await handle.getFile()).text();
            } catch (err) {
                if (err?.name === "AbortError") throw err;
                await forgetHandle();
            }
        }
        const [picked] = await window.showOpenFilePicker({ types: FILE_TYPES });
        const file = await picked.getFile();
        await storeHandle(picked);
        return await file.text();
    }

    // Fallback: a hidden file input.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt";
    input.style.display = "none";
    document.body.appendChild(input);
    try {
        return await new Promise((resolve) => {
            input.addEventListener("change", () => {
                const file = input.files && input.files[0];
                if (!file) return resolve(null);
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsText(file);
            });
            input.addEventListener("cancel", () => resolve(null));
            input.click();
        });
    } finally {
        input.remove();
    }
}
