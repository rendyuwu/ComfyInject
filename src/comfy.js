import { MODULE_NAME } from "../settings.js";
import { resolveSeed } from "./state.js";
import { saveImageLocally } from "./save.js";
import { enqueue, queueDepth } from "./queue.js";
import { fetchWithTimeout, isTimeoutError, requestTimeoutMs } from "./http.js";
import { substituteTrimmed } from "./macros.js";

const EXTENSION_FOLDER = `scripts/extensions/third-party/ComfyInject`;

// How long to wait between polls (ms)
const POLL_INTERVAL_MS = 1000;

// The workflow is a static file served by SillyTavern itself, so it either
// answers immediately or something is badly wrong.
const WORKFLOW_TIMEOUT_MS = 15000;

// A single /history poll is cheap; anything slower than this is a stall, and the
// next poll a second later is a free retry.
const POLL_TIMEOUT_MS = 15000;

// How many polls in a row may fail before the generation is abandoned. One
// blip while ComfyUI reloads a model should not lose the job, but a ComfyUI that
// has gone away should not hold the queue for the full attempt budget either.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * Gets the current ComfyInject settings from SillyTavern's extension settings.
 * @returns {object} The current settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

/**
 * Loads the workflow JSON from the workflows folder.
 * Uses the filename from settings so users can swap workflows.
 * @returns {Promise<object>} The parsed workflow object
 */
async function loadWorkflow() {
    const settings = getSettings();
    const filename = settings.workflow || "comfyinject_default.json";
    const response = await fetchWithTimeout(
        `/${EXTENSION_FOLDER}/workflows/${filename}`,
        {},
        WORKFLOW_TIMEOUT_MS
    );
    if (!response.ok) {
        throw new Error(`[ComfyInject] Failed to load workflow "${filename}": ${response.status}`);
    }
    return await response.json();
}

/**
 * Fills all {{PLACEHOLDER}} tokens in the workflow with real values.
 * Operates on a deep copy so the original is never mutated.
 * @param {object} workflow - The raw workflow object
 * @param {object} values - Key/value pairs to substitute
 * @returns {object} The filled workflow object
 */
function fillWorkflow(workflow, values) {
    let workflowStr = JSON.stringify(workflow);

    for (const [key, value] of Object.entries(values)) {
        const placeholder = `"{{${key}}}"`;
        const replacement = JSON.stringify(value);
        while (workflowStr.includes(placeholder)) {
            workflowStr = workflowStr.replace(placeholder, replacement);
        }
    }

    return JSON.parse(workflowStr);
}

/**
 * POSTs the filled workflow to ComfyUI's /prompt endpoint.
 * @param {object} workflow - The filled workflow object
 * @param {string} host - ComfyUI host URL
 * @returns {Promise<string>} The prompt_id returned by ComfyUI
 */
async function submitPrompt(workflow, host) {
    const response = await fetchWithTimeout(`${host}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
    }, requestTimeoutMs());

    if (!response.ok) {
        throw new Error(`[ComfyInject] Failed to submit prompt: ${response.status}`);
    }

    const data = await response.json();

    if (!data.prompt_id) {
        throw new Error(`[ComfyInject] ComfyUI response missing prompt_id`);
    }

    return data.prompt_id;
}

/**
 * Polls /history/{prompt_id} until the image is ready or we time out.
 *
 * Each poll carries its own deadline, so a socket that never settles costs one
 * attempt instead of hanging the queue forever. A run of failed polls means
 * ComfyUI has gone away and is reported as such rather than as a slow image.
 *
 * @param {string} promptId - The prompt_id from submitPrompt
 * @param {string} host - ComfyUI host URL
 * @param {number} maxAttempts - Maximum number of poll attempts before giving up
 * @returns {Promise<{filename: string, subfolder: string}>} The filename and subfolder of the generated image
 */
async function pollForResult(promptId, host, maxAttempts) {
    const pollTimeout = Math.min(requestTimeoutMs(), POLL_TIMEOUT_MS);
    let consecutiveFailures = 0;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

        let response;
        try {
            response = await fetchWithTimeout(`${host}/history/${promptId}`, {}, pollTimeout);
        } catch (err) {
            lastError = err;
            consecutiveFailures++;
            console.warn(
                `[ComfyInject] Poll ${attempt + 1} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}):`,
                isTimeoutError(err) ? err.message : err
            );
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                throw new Error(
                    `[ComfyInject] ComfyUI stopped responding while waiting for ${promptId}: ${lastError?.message ?? lastError}`
                );
            }
            continue;
        }

        consecutiveFailures = 0;

        if (!response.ok) continue;

        const history = await response.json();
        const result = history[promptId];

        if (!result) continue;

        // Walk the outputs to find a SaveImage node result
        const outputs = result.outputs;
        for (const nodeId of Object.keys(outputs)) {
            const images = outputs[nodeId]?.images;
            if (images && images.length > 0) {
                return { filename: images[0].filename, subfolder: images[0].subfolder ?? "" };
            }
        }
    }

    throw new Error(`[ComfyInject] Timed out waiting for image after ${maxAttempts} attempts`);
}

/**
 * Builds the full /view URL for a generated image.
 * @param {string} filename - The image filename from pollForResult
 * @param {string} host - ComfyUI host URL
 * @returns {string} The full image URL
 */
function buildImageUrl(filename, subfolder, host) {
    const params = new URLSearchParams({ filename, type: "output" });
    if (subfolder) params.set("subfolder", subfolder);
    return `${host}/view?${params.toString()}`;
}

/**
 * @typedef {object} GenerateImageParams
 * @property {string} prompt - The positive prompt text
 * @property {string} ar - Aspect ratio token (PORTRAIT, SQUARE, etc.)
 * @property {string} shot - Shot type token (CLOSE, MEDIUM, etc.)
 * @property {number} seed - The resolved numeric seed (LOCK/RANDOM already resolved by state.js)
 * @property {number} messageIndex - The index of the message being processed (needed for LOCK seed resolution)
 * @property {boolean} [bypassSeedLock] - If true, skip the seed lock and use the provided seed directly (used by retry)
 *
 * @typedef {{imageUrl: string, seed: number, prompt: string, promptId: string, filename: string, effectiveAr: string, effectiveShot: string, resolution: {width: number, height: number}, shotTags: string}} GenerateImageResult
 */

/**
 * Main entry point. Takes parsed marker data and returns a usable image URL.
 *
 * Every submission is serialized through the shared queue, so the marker path,
 * the dedicated prompter and the retry button can never hit ComfyUI at once.
 *
 * @param {GenerateImageParams} params
 * @returns {Promise<GenerateImageResult>}
 */
export function generateImage(params) {
    const pending = queueDepth();
    if (pending > 0) {
        console.log(`[ComfyInject] Queued behind ${pending} pending image(s)`);
    }
    return enqueue(() => runGeneration(params));
}

/**
 * The actual generation. Only ever called from the queue.
 * @param {GenerateImageParams} params
 * @returns {Promise<GenerateImageResult>}
 */
async function runGeneration({ prompt, ar, shot, seed, messageIndex, bypassSeedLock = false }) {
    const settings = getSettings();

    // Resolve resolution — use locked resolution if enabled, otherwise use the AR token
    const resolution = settings.resolution_lock_enabled
        ? settings.resolution_lock
        : settings.resolutions[ar];

    if (!resolution) {
        throw new Error(`[ComfyInject] Unknown AR token: ${ar}`);
    }

    // Prepend shot tags to the positive prompt — use locked shot if enabled, otherwise use the LLM's token
    const effectiveShot = settings.shot_lock_enabled ? settings.shot_lock : shot;
    const shotTag = settings.shot_tags?.[effectiveShot] ?? "";
    // Macros are expanded here, not on save: these are the user's own strings, so
    // {{char}} in Prepend Prompt has to mean whoever the chat is about right now.
    const prepend = substituteTrimmed(settings.prepend_prompt);
    const append = substituteTrimmed(settings.append_prompt);

    // Build the final positive prompt: prepend prompt, shot tags, LLM prompt, append prompt
    const parts = [prepend, shotTag, prompt, append].filter(Boolean);
    const positivePrompt = parts.join(", ");

    // Resolve seed — use locked seed mode if enabled (unless bypassed by retry), otherwise use the provided seed
    const effectiveSeed = (settings.seed_lock_enabled && !bypassSeedLock)
        ? resolveSeed(settings.seed_lock_mode === "CUSTOM" ? settings.seed_lock_value : settings.seed_lock_mode, messageIndex)
        : seed;

    // Load and fill the workflow
    const workflow = await loadWorkflow();
    const filled = fillWorkflow(workflow, {
        CHECKPOINT:       settings.checkpoint,
        POSITIVE_PROMPT:  positivePrompt,
        NEGATIVE_PROMPT:  settings.negative_prompt,
        WIDTH:            resolution.width,
        HEIGHT:           resolution.height,
        SEED:             effectiveSeed,
        STEPS:            settings.steps,
        CFG:              settings.cfg,
        SAMPLER:          settings.sampler,
        SCHEDULER:        settings.scheduler,
        DENOISE:          settings.denoise,
    });

    // Submit to ComfyUI and wait for the result
    const promptId = await submitPrompt(filled, settings.comfy_host);
    console.log(`[ComfyInject] Job submitted, prompt_id: ${promptId}`);

    const maxAttempts = settings.max_poll_attempts ?? 180;
    const { filename, subfolder } = await pollForResult(promptId, settings.comfy_host, maxAttempts);
    console.log(`[ComfyInject] Image ready: ${filename}`);

    const comfyUrl = buildImageUrl(filename, subfolder, settings.comfy_host);

    // Copy the image into SillyTavern so the message does not hotlink to ComfyUI.
    // Falls back to the ComfyUI URL if saving is disabled or fails.
    const imageUrl = await saveImageLocally(comfyUrl, filename);

    return {
        imageUrl,
        seed: effectiveSeed,
        prompt,
        promptId,
        filename,
        // Effective values — what was actually sent to ComfyUI
        effectiveAr: settings.resolution_lock_enabled ? "LOCKED" : ar,
        effectiveShot: settings.shot_lock_enabled ? "LOCKED" : shot,
        resolution: { width: resolution.width, height: resolution.height },
        shotTags: shotTag,
    };
}