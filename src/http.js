// Every network request ComfyInject makes goes through here.
//
// Nothing in this extension used to carry a request deadline. max_poll_attempts
// bounds the *number* of ComfyUI polls, not the time any single fetch may spend
// hanging, so one socket that never settled stalled the whole serial image queue
// behind it — the marker path, the dedicated path and the retry button alike.
//
// Two deadlines are exposed rather than one: a control-plane request (submit a
// job, poll a status, read a workflow file) should give up quickly, while an
// image download or a base64 upload is moving real bytes and needs longer.

import { MODULE_NAME } from "../settings.js";

// Used when the setting is missing or unreadable — a fresh install, or a
// getContext() that throws while SillyTavern is still booting.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// Bounds on what the setting is allowed to ask for.
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

// Floor for requests that transfer image bytes, regardless of the setting.
const MIN_TRANSFER_TIMEOUT_MS = 60000;

/**
 * Reads the configured request timeout, clamped to something sane.
 * Deliberately tolerant: this module is called from the cleanup path and from
 * the settings UI, either of which can run before settings are readable.
 * @returns {number} Milliseconds
 */
function readTimeoutSetting() {
    try {
        const raw = SillyTavern.getContext().extensionSettings?.[MODULE_NAME]?.request_timeout_ms;
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) {
            return Math.min(Math.max(value, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
        }
    } catch (err) {
        // Settings unreadable — fall through to the default.
    }
    return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Deadline for a control-plane request: submit, poll, read a file, delete.
 * @returns {number} Milliseconds
 */
export function requestTimeoutMs() {
    return readTimeoutSetting();
}

/**
 * Deadline for a request that transfers image bytes.
 * @returns {number} Milliseconds
 */
export function transferTimeoutMs() {
    return Math.max(readTimeoutSetting(), MIN_TRANSFER_TIMEOUT_MS);
}

/**
 * True when a failure is this module's own deadline rather than a real
 * network or server error, so callers can say so instead of guessing.
 * @param {any} error
 * @returns {boolean}
 */
export function isTimeoutError(error) {
    return error?.name === "TimeoutError";
}

/**
 * Trims a URL for a log line without hiding which endpoint it was.
 * @param {string} url
 * @returns {string}
 */
function shortenUrl(url) {
    const text = String(url);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * @param {string} url
 * @param {number} ms
 * @returns {Error} An error whose name callers can test with isTimeoutError()
 */
function timeoutError(url, ms) {
    const error = new Error(`[ComfyInject] Request timed out after ${ms} ms: ${shortenUrl(url)}`);
    error.name = "TimeoutError";
    return error;
}

/**
 * fetch() with a deadline, composed with any signal the caller passes.
 *
 * A timeout is reported as a TimeoutError naming the endpoint; an abort from the
 * caller's own signal is passed through untouched, so an intentional cancel is
 * never mistaken for a hung server.
 *
 * @param {string} url - The request URL
 * @param {RequestInit} [options] - Standard fetch options; options.signal is honoured
 * @param {number} [timeoutMs] - Deadline in ms; 0 or negative disables it
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = requestTimeoutMs()) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    if (!ms) return await fetch(url, options);

    const external = options.signal ?? null;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError(url, ms));
    }, ms);

    const onExternalAbort = () => controller.abort(external?.reason);
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener?.("abort", onExternalAbort, { once: true });

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        // AbortController.abort(reason) support varies, so the flag decides
        // rather than the rejection value.
        if (timedOut) throw timeoutError(url, ms);
        throw err;
    } finally {
        clearTimeout(timer);
        external?.removeEventListener?.("abort", onExternalAbort);
    }
}
