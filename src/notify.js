// One place that decides whether ComfyInject is allowed to interrupt the user.
//
// repair_toast_mode started life as a marker-repair switch, but it is the only
// notification preference this extension has, so every automatic path honours it:
//
//   "all"      — repair notices as well as failures
//   "failures" — failures only (the default)
//   "off"      — nothing automatic
//
// A user-initiated action always answers, whatever the mode says. Pressing a
// button and getting silence is a bug, not a preference.

import { MODULE_NAME } from "../settings.js";

/**
 * @returns {"all" | "failures" | "off"}
 */
export function getToastMode() {
    try {
        return SillyTavern.getContext().extensionSettings?.[MODULE_NAME]?.repair_toast_mode || "failures";
    } catch (err) {
        return "failures";
    }
}

/**
 * True when failure notifications are wanted at all.
 * @returns {boolean}
 */
export function failureToastsEnabled() {
    return getToastMode() !== "off";
}

/**
 * True when the chatty repair notices are wanted.
 * @returns {boolean}
 */
export function repairToastsEnabled() {
    return getToastMode() === "all";
}

/**
 * An error the user should probably act on.
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.force] - True for a user-initiated action, which always answers
 */
export function notifyFailure(text, { force = false } = {}) {
    if (!force && !failureToastsEnabled()) return;
    toastr.error(text, "ComfyInject");
}

/**
 * Something went wrong but the outcome is still usable.
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.force] - True for a user-initiated action, which always answers
 */
export function notifyWarning(text, { force = false } = {}) {
    if (!force && !failureToastsEnabled()) return;
    toastr.warning(text, "ComfyInject");
}

/**
 * A repair or bookkeeping notice — only shown in "all".
 * @param {string} text
 */
export function notifyRepair(text) {
    if (!repairToastsEnabled()) return;
    toastr.warning(text, "ComfyInject");
}
