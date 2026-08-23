// Logging helpers for the dedicated prompter.
// Debug output is opt-in via the prompter_debug setting so a normal session
// stays quiet, while a misbehaving prompter can be diagnosed without a rebuild.

import { MODULE_NAME } from "../../settings.js";

export const LOG_PREFIX = "[ComfyInject/prompter]";

/**
 * Returns true when prompter debug logging is enabled.
 * @returns {boolean}
 */
export function debugEnabled() {
    try {
        return !!SillyTavern.getContext().extensionSettings?.[MODULE_NAME]?.prompter_debug;
    } catch (err) {
        return false;
    }
}

/**
 * Logs only when prompter debug logging is enabled.
 * @param {...any} args
 */
export function debugLog(...args) {
    if (debugEnabled()) console.debug(LOG_PREFIX, ...args);
}

/**
 * Logs a warning regardless of the debug setting.
 * @param {...any} args
 */
export function warnLog(...args) {
    console.warn(LOG_PREFIX, ...args);
}
