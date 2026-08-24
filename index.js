import { initDom } from "./src/dom.js";
import { initUI } from "./src/ui.js";
import { initLazyImages } from "./src/lazy-images.js";
import { initCleanup } from "./src/cleanup.js";
import { initDirector } from "./src/prompter/director.js";
import { MODULE_NAME, defaultSettings, DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT } from "./settings.js";
// Straight from defaults.js: this is not text any field is ever set to, only a
// fingerprint of what an earlier version shipped. Keeping it out of settings.js's
// export list keeps that list meaning "the text a Restore-default button writes".
import { DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT_V10 } from "./src/prompter/defaults.js";

// Import outbound so comfyInjectInterceptor gets registered on globalThis
import "./src/outbound.js";

/**
 * Initializes ComfyInject settings.
 * Merges defaults with any existing saved settings so new
 * keys are always present after an update.
 */
function initSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = {};
    }

    // Merge defaults into existing settings so new keys are always present
    const saved = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!(key in saved)) {
            saved[key] = structuredClone(defaultSettings[key]);
        }
    }

    migrateSeedSystemPrompt(saved);

    saveSettingsDebounced();
}

/**
 * Carries an untouched Seeding Instructions field forward to the current default.
 *
 * Key-by-key merging only adds keys that are missing, so an install that has ever
 * run the prompter keeps whatever seeding prompt shipped at the time — including
 * one that never mentions the chat, which would leave the chat-aware seeding pass
 * reading a CHAT SO FAR section it was never told to prefer.
 *
 * Only an exact match against a shipped string is rewritten. Anything else is the
 * user's own work, and silently overwriting an edited prompt on upgrade is the one
 * thing the Restore-default buttons exist to avoid.
 *
 * @param {Record<string, any>} saved
 */
function migrateSeedSystemPrompt(saved) {
    if (saved.prompter_seed_system_prompt !== DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT_V10) return;

    saved.prompter_seed_system_prompt = DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT;
    console.log("[ComfyInject] Upgraded the untouched seeding instructions to the chat-aware default");
}

// Entry point
(async () => {
    console.log("[ComfyInject] Loading...");

    initSettings();
    initLazyImages();
    await initUI();
    initDom();
    // After initDom: ST's event emitter awaits listeners in registration order,
    // so the marker path gets first refusal on a new message in "both" mode.
    initDirector();
    initCleanup();

    console.log("[ComfyInject] Ready!");
})();