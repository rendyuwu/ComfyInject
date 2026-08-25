import {
    MODULE_NAME,
    defaultSettings,
    DEFAULT_PROMPTER_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE,
    DEFAULT_PROMPTER_EXAMPLE_PROMPT,
    DEFAULT_PROMPTER_USER_TURN,
    DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS,
    DEFAULT_PROMPTER_SEED_USER_TURN,
} from "../settings.js";
// Straight from defaults.js rather than through settings.js's re-exports: these
// two are not defaults any field is ever set to, only fingerprints of what an
// earlier version shipped. Keeping them out of the settings export list keeps
// that list meaning "the text a Restore-default button writes".
import {
    DEFAULT_PROMPTER_SYSTEM_PROMPT_V8,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE_V8,
} from "./prompter/defaults.js";
import { openGallery } from "./gallery.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, requestTimeoutMs } from "./http.js";
import { openContextPreview, openPrompterTest } from "./prompter/preview.js";
import { escapeHtml, injectStyle } from "./prompter/overlay.js";
import { openAppearanceEditor } from "./prompter/appearance-ui.js";
import { getPrefillStatus, resetTransportState } from "./prompter/llm.js";
import { addDirectButtons } from "./prompter/director.js";
import {
    loadPrompterSettingsFile,
    parsePrompterFile,
    savePrompterSettingsFile,
    serializePrompterFile,
} from "./prompter/settingsfile.js";

const EXTENSION_FOLDER = `scripts/extensions/third-party/ComfyInject`;

// Panel-wide styles: the mobile wrap rules, the disclosure toggles' caret
// behaviour, and the spacing/label classes that replaced the repeated inline
// styles. Injected once; media queries cannot live in an inline style attribute.
const SETTINGS_CSS = `
#comfyinject_settings .comfyinject-disclosure {
    align-items: center;
}
#comfyinject_settings .comfyinject-disclosure-caret {
    transition: transform 0.15s ease;
}
#comfyinject_settings .comfyinject-disclosure-caret.down {
    transform: rotate(-90deg);
}
#comfyinject_settings .comfyinject-row { margin-top: 4px; }
#comfyinject_settings .comfyinject-tools-row { margin-top: 8px; }
#comfyinject_settings .comfyinject-stack { margin-top: 8px; }
@media (max-width:700px){
    /* The !importants are load-bearing: several controls carry inline
       width styles, and an inline style outranks any selector here. */
    #comfyinject_settings .flex-container{flex-wrap:wrap}
    #comfyinject_settings select.text_pole,
    #comfyinject_settings textarea.text_pole{width:100% !important;min-width:0}
    #comfyinject_settings .flex-container>label{width:auto !important;min-width:110px}
    #comfyinject_settings input[type="number"].text_pole{flex:1 1 80px;width:auto !important}
}
`;

// Dedicated prompter fields, bound declaratively — one table instead of a
// second wall of near-identical handlers.
// [selector, settings key, kind]
const PROMPTER_FIELDS = [
    ["#comfyinject_trigger_mode", "trigger_mode", "select"],
    ["#comfyinject_prompter_structured_mode", "prompter_structured_mode", "select"],
    ["#comfyinject_prompter_rules_verbosity", "prompter_rules_verbosity", "select"],
    ["#comfyinject_prompter_generate_policy", "prompter_generate_policy", "select"],
    ["#comfyinject_prompter_appearance_scope", "prompter_appearance_scope", "select"],
    ["#comfyinject_prompter_lore_mode", "prompter_lore_mode", "select"],
    ["#comfyinject_prompter_max_tokens", "prompter_max_tokens", "int"],
    ["#comfyinject_prompter_timeout_ms", "prompter_timeout_ms", "int"],
    ["#comfyinject_prompter_history_count", "prompter_history_count", "int"],
    ["#comfyinject_prompter_history_anchor", "prompter_history_anchor", "int"],
    ["#comfyinject_prompter_previous_image_count", "prompter_previous_image_count", "int"],
    ["#comfyinject_prompter_lore_max_chars", "prompter_lore_max_chars", "int"],
    ["#comfyinject_prompter_seed_history_count", "prompter_seed_history_count", "int"],
    ["#comfyinject_prompter_seed_refresh_messages", "prompter_seed_refresh_messages", "int"],
    ["#comfyinject_prompter_max_images_per_message", "prompter_max_images_per_message", "int"],
    ["#comfyinject_prompter_max_tags", "prompter_max_tags", "int"],
    ["#comfyinject_prompter_registry_max_chars", "prompter_registry_max_chars", "int"],
    ["#comfyinject_prompter_auto", "prompter_auto", "checkbox"],
    ["#comfyinject_prompter_include_card", "prompter_include_card", "checkbox"],
    ["#comfyinject_prompter_include_persona", "prompter_include_persona", "checkbox"],
    ["#comfyinject_prompter_include_author_note", "prompter_include_author_note", "checkbox"],
    ["#comfyinject_prompter_include_summary", "prompter_include_summary", "checkbox"],
    ["#comfyinject_prompter_appearance_enabled", "prompter_appearance_enabled", "checkbox"],
    ["#comfyinject_prompter_allow_registry_lora", "prompter_allow_registry_lora", "checkbox"],
    ["#comfyinject_prompter_appearance_autoseed", "prompter_appearance_autoseed", "checkbox"],
    ["#comfyinject_prompter_seed_include_summary", "prompter_seed_include_summary", "checkbox"],
    ["#comfyinject_prompter_debug", "prompter_debug", "checkbox"],
    ["#comfyinject_prompter_system_prompt", "prompter_system_prompt", "text"],
    ["#comfyinject_prompter_constraints", "prompter_constraints", "text"],
    ["#comfyinject_prompter_banned_tags", "prompter_banned_tags", "text"],
    ["#comfyinject_prompter_example_prompt", "prompter_example_prompt", "text"],
    ["#comfyinject_prompter_final_instructions", "prompter_final_instructions", "text"],
    ["#comfyinject_prompter_user_turn", "prompter_user_turn", "text"],
    ["#comfyinject_prompter_prefill", "prompter_prefill", "text"],
    ["#comfyinject_prompter_seed_system_prompt", "prompter_seed_system_prompt", "text"],
    ["#comfyinject_prompter_seed_example_tags", "prompter_seed_example_tags", "text"],
    ["#comfyinject_prompter_seed_final_instructions", "prompter_seed_final_instructions", "text"],
    ["#comfyinject_prompter_seed_user_turn", "prompter_seed_user_turn", "text"],
];

// The Prompter Instructions default depends on the generate policy: "judge" has
// to restore the exact text that shipped in Phase 7, not a paraphrase of it.
// @param {string} policy
// @returns {string}
function systemPromptDefault(policy) {
    return policy === "judge" ? DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE : DEFAULT_PROMPTER_SYSTEM_PROMPT;
}

// Every shipped TASK body, current and historical. A field holding any of them is
// text this extension wrote, not text the user wrote, so the generate-policy
// switch may carry it over. Without the older entries an install that upgraded
// through Phase 8 would have its untouched field classed as edited and left
// holding a bullet pointing at a section that may not exist.
const PRISTINE_SYSTEM_PROMPTS = [
    DEFAULT_PROMPTER_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_V8,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE_V8,
];

// Restore-default buttons, bound the same declarative way. Each one restores its
// own field and nothing else, and the default it writes is the same export
// defaultSettings uses — never a second copy living in this file.
// The default is a function of the live settings rather than a constant, because
// Prompter Instructions has one default per generate policy.
// [button selector, field selector, settings key, () => default value, toast text]
const PROMPTER_RESETS = [
    ["#comfyinject_prompter_system_prompt_reset", "#comfyinject_prompter_system_prompt", "prompter_system_prompt", () => systemPromptDefault(getSettings().prompter_generate_policy), "Default prompter instructions restored."],
    ["#comfyinject_prompter_example_prompt_reset", "#comfyinject_prompter_example_prompt", "prompter_example_prompt", () => DEFAULT_PROMPTER_EXAMPLE_PROMPT, "Default example image prompt restored."],
    ["#comfyinject_prompter_user_turn_reset", "#comfyinject_prompter_user_turn", "prompter_user_turn", () => DEFAULT_PROMPTER_USER_TURN, "Default user turn restored."],
    ["#comfyinject_prompter_seed_system_prompt_reset", "#comfyinject_prompter_seed_system_prompt", "prompter_seed_system_prompt", () => DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT, "Default seeding instructions restored."],
    ["#comfyinject_prompter_seed_example_tags_reset", "#comfyinject_prompter_seed_example_tags", "prompter_seed_example_tags", () => DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS, "Default seeding example tags restored."],
    ["#comfyinject_prompter_seed_user_turn_reset", "#comfyinject_prompter_seed_user_turn", "prompter_seed_user_turn", () => DEFAULT_PROMPTER_SEED_USER_TURN, "Default seeding user turn restored."],
];

/**
 * Gets the current live settings from ST.
 * @returns {object}
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

/**
 * Saves the current settings to ST.
 */
function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Parses a numeric input value, falling back when it is empty or unparseable
 * rather than storing NaN — which JSON.stringify turns into null and ComfyUI
 * rejects with an opaque 400. Every numeric field uses this; the fallback is
 * always the same default defaultSettings ships for that key.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function intOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/** Same contract as intOr for float fields (CFG, denoise).
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function floatOr(value, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Fetches the list of available checkpoints from ComfyUI.
 * @returns {Promise<string[]>} Array of checkpoint filenames, or empty array on failure
 */
async function fetchCheckpoints() {
    const settings = getSettings();
    try {
        const response = await fetchWithTimeout(
            `${settings.comfy_host}/object_info/CheckpointLoaderSimple`,
            {},
            requestTimeoutMs()
        );
        if (!response.ok) return [];
        const data = await response.json();
        return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    } catch (err) {
        return [];
    }
}

/**
 * Validates that a workflow file exists in the workflows folder.
 * Shows a toastr error if the file doesn't exist, success if it does.
 * @param {string} filename - The workflow filename to validate
 */
async function validateWorkflow(filename) {
    if (!filename || !filename.trim()) return;
    try {
        const response = await fetchWithTimeout(
            `/${EXTENSION_FOLDER}/workflows/${filename.trim()}`,
            { method: "HEAD" },
            requestTimeoutMs()
        );
        if (response.ok) {
            toastr.success(`Workflow "${filename}" found!`, "ComfyInject");
        } else {
            toastr.error(`Workflow "${filename}" not found in the workflows folder.`, "ComfyInject");
        }
    } catch (err) {
        toastr.error(`Could not check workflow file.`, "ComfyInject");
    }
}

/**
 * Fetches checkpoints from ComfyUI and populates the dropdown.
 * Called on init and when the arrow button is clicked.
 * @param {boolean} [showToast=true] - Whether to show a toast notification
 */
async function refreshCheckpointList(showToast = true) {
    const checkpoints = await fetchCheckpoints();
    const dropdown = $("#comfyinject_checkpoint_dropdown");
    dropdown.empty();

    if (checkpoints.length > 0) {
        const current = getSettings().checkpoint;
        for (const name of checkpoints) {
            const safeName = escapeHtml(name);
            dropdown.append(
                `<div class="comfyinject-checkpoint-option" data-value="${safeName}" style="padding: 6px 10px; cursor: pointer; ${name === current ? "font-weight: bold;" : ""}">${safeName}</div>`
            );
        }
        if (showToast) {
            toastr.success(`Found ${checkpoints.length} checkpoint(s)`, "ComfyInject");
        }
    } else if (showToast) {
        toastr.warning("Could not reach ComfyUI. Is it running?", "ComfyInject");
    }
}

/**
 * Updates the resolution lock inputs visibility and the per-token
 * resolution inputs opacity based on the lock state.
 * @param {boolean} locked - Whether resolution lock is enabled
 */
function updateResolutionLockUI(locked) {
    $("#comfyinject_resolution_lock_inputs").toggle(locked);
    // Dim the per-token inputs when locked so it's obvious they're being ignored
    $("#comfyinject_resolutions").css("opacity", locked ? 0.4 : 1.0);
    $("#comfyinject_resolutions").css("pointer-events", locked ? "none" : "auto");
}

/**
 * Updates the shot lock inputs visibility and the per-token
 * shot tag inputs opacity based on the lock state.
 * @param {boolean} locked - Whether shot lock is enabled
 */
function updateShotLockUI(locked) {
    $("#comfyinject_shot_lock_inputs").toggle(locked);
    // Dim the per-token inputs when locked so it's obvious they're being ignored
    $("#comfyinject_shot_tags").css("opacity", locked ? 0.4 : 1.0);
    $("#comfyinject_shot_tags").css("pointer-events", locked ? "none" : "auto");
}

/**
 * Updates the seed lock inputs visibility and the custom seed input
 * visibility based on the lock state and selected mode.
 * @param {boolean} locked - Whether seed lock is enabled
 */
function updateSeedLockUI(locked) {
    $("#comfyinject_seed_lock_inputs").toggle(locked);
    // Show the custom seed input only when mode is CUSTOM
    const mode = $("#comfyinject_seed_lock_mode").val();
    $("#comfyinject_seed_lock_custom_input").toggle(locked && mode === "CUSTOM");
}


/**
 * Updates the local image saving sub-options visibility based on
 * whether saving and downscaling are enabled.
 * @param {boolean} saving - Whether local image saving is enabled
 * @param {boolean} downscaling - Whether downscaling is enabled
 */
function updateSaveImagesUI(saving, downscaling) {
    $("#comfyinject_save_images_options").toggle(saving);
    $("#comfyinject_downscale_inputs").toggle(saving && downscaling);
}

/**
 * Fills the connection profile dropdown.
 *
 * The Connection Manager owns the dropdown when it can, which keeps it in sync as
 * profiles are added or renamed. The manual list is the fallback for builds where
 * handleDropdown is missing or throws.
 */
function populatePrompterProfiles() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const select = $("#comfyinject_prompter_profile_id");
    if (!select.length) return;

    const service = context.ConnectionManagerRequestService;
    const disabled = !!context.extensionSettings?.disabledExtensions?.includes("connection-manager");

    if (disabled || !service) {
        select.html(`<option value="">Connection Manager is disabled — using the main API</option>`);
        return;
    }

    if (typeof service.handleDropdown === "function") {
        try {
            service.handleDropdown("#comfyinject_prompter_profile_id", settings.prompter_profile_id, (profile) => {
                getSettings().prompter_profile_id = profile?.id || "";
                resetTransportState();
                updatePrefillNote();
                saveSettings();
            });
            return;
        } catch (err) {
            console.warn("[ComfyInject] handleDropdown failed, falling back to a manual profile list", err);
        }
    }

    const profiles = Array.isArray(context.extensionSettings?.connectionManager?.profiles)
        ? context.extensionSettings.connectionManager.profiles
        : [];
    const supported = profiles.filter((profile) => {
        try {
            return typeof service.isProfileSupported !== "function" || service.isProfileSupported(profile);
        } catch (err) {
            return false;
        }
    });

    select.empty();
    select.append(`<option value="">-- Use the active main API --</option>`);
    for (const profile of supported) {
        const label = profile.name || profile.id;
        select.append(`<option value="${escapeHtml(profile.id)}">${escapeHtml(label)}</option>`);
    }
    select.val(settings.prompter_profile_id || "");

    // This change handler belongs to the manual fallback list only — when
    // handleDropdown is available it owns the element's behaviour instead.
    // Namespaced + off first so re-population cannot stack handlers.
    select.off("change.comfyinjectProfile").on("change.comfyinjectProfile", function () {
        const value = $(this).val();
        if (getSettings().prompter_profile_id === value) return;
        getSettings().prompter_profile_id = value;
        resetTransportState();
        // Selecting a profile is what makes a prefill inert.
        updatePrefillNote();
        saveSettings();
    });
}

/**
 * Fills the preset override dropdown. The preset manager only exists for the
 * currently selected API, so an empty list is normal rather than an error.
 */
function populatePrompterPresets() {
    const select = $("#comfyinject_prompter_preset");
    if (!select.length) return;

    let presets = [];
    try {
        presets = SillyTavern.getContext().getPresetManager?.()?.getAllPresets?.() || [];
    } catch (err) {
        presets = [];
    }

    const current = getSettings().prompter_preset || "";
    select.empty();
    select.append(`<option value="">-- Use the profile's own preset --</option>`);
    for (const preset of presets) {
        const safePreset = escapeHtml(preset);
        select.append(`<option value="${safePreset}">${safePreset}</option>`);
    }
    select.val(presets.includes(current) ? current : "");
}

/**
 * States whether a configured prefill would actually be sent. A setting that is
 * silently ignored reads as a broken field, so the panel says which it is.
 */
function updatePrefillNote() {
    const note = $("#comfyinject_prompter_prefill_note");
    if (!note.length) return;

    let status;
    try {
        status = getPrefillStatus();
    } catch (err) {
        status = { active: false, reason: "" };
    }

    if (!status.reason) {
        note.text("Only the no-profile transport supports a prefill, and only on requests that are not schema-constrained.");
        return;
    }
    note.text(status.reason);
}

/**
 * Moves Prompter Instructions to the new policy's shipped default when — and only
 * when — the field still holds one of the shipped defaults verbatim, this
 * version's or an earlier one's.
 *
 * A pristine field following the policy is what the user means by switching it.
 * An edited field is theirs, so it is left alone and the panel says so; the
 * Restore-default button is the way to take the new text deliberately.
 */
function syncSystemPromptToPolicy() {
    const settings = getSettings();
    const wanted = systemPromptDefault(settings.prompter_generate_policy);
    const current = String(settings.prompter_system_prompt ?? "");
    if (current === wanted) return;

    const pristine = PRISTINE_SYSTEM_PROMPTS.includes(current);

    if (!pristine) {
        toastr.info(
            "Your edited Prompter Instructions were kept. Use Restore default to take this policy's shipped text.",
            "ComfyInject"
        );
        return;
    }

    settings.prompter_system_prompt = wanted;
    $("#comfyinject_prompter_system_prompt").val(wanted);
}

/**
 * Populates the dedicated prompter fields from current settings.
 */
function populatePrompterUI() {
    const settings = getSettings();

    for (const [selector, key, kind] of PROMPTER_FIELDS) {
        const $el = $(selector);
        if (!$el.length) {
            // A selector typo would otherwise fail silently as a jQuery no-op.
            console.warn(`[ComfyInject] PROMPTER_FIELDS selector matched nothing: ${selector}`);
            continue;
        }
        if (kind === "checkbox") $el.prop("checked", !!settings[key]);
        else $el.val(settings[key] ?? "");
    }

    populatePrompterProfiles();
    populatePrompterPresets();
    updatePrefillNote();
}

/**
 * Writes every prompter prose field (the "text" rows of PROMPTER_FIELDS) to a
 * file the user picks. The section list is not duplicated here: the same table
 * that binds the panel is the file's section list, in table order, so a saved
 * file diffs cleanly against the previous save.
 */
async function savePrompterSettingsToFile() {
    const settings = getSettings();
    const sections = PROMPTER_FIELDS
        .filter(([, , kind]) => kind === "text")
        .map(([, key]) => ({ key, value: settings[key] ?? "" }));
    try {
        await savePrompterSettingsFile(serializePrompterFile(sections));
        toastr.success("Prompter settings saved to file.", "ComfyInject");
    } catch (err) {
        if (err?.name === "AbortError") return; // picker dismissed
        console.warn("[ComfyInject] Could not save prompter settings file:", err);
        toastr.error("Could not save the file.", "ComfyInject");
    }
}

/**
 * Reads a prompter-settings file back into the panel. Unknown keys and
 * non-prose keys are ignored, so the file is forward-compatible with newer
 * section names. A present-but-empty section applies "" — a cleared field is
 * distinct from an absent one, which is left untouched.
 */
async function loadPrompterSettingsFromFile() {
    let text;
    try {
        text = await loadPrompterSettingsFile();
    } catch (err) {
        if (err?.name === "AbortError") return; // picker dismissed
        console.warn("[ComfyInject] Could not load prompter settings file:", err);
        toastr.error("Could not load the file.", "ComfyInject");
        return;
    }
    if (text === null) return;

    const settings = getSettings();
    const parsed = parsePrompterFile(text);
    let applied = 0;
    for (const [key, value] of Object.entries(parsed)) {
        const row = PROMPTER_FIELDS.find(([, k]) => k === key);
        if (!row || row[2] !== "text") continue;
        settings[key] = value;
        applied++;
    }
    saveSettings();
    populatePrompterUI();
    toastr.success(`Loaded ${applied} prompter field${applied === 1 ? "" : "s"} from file.`, "ComfyInject");
}

/**
 * Populates all input fields from current settings.
 */
function populateUI() {
    const settings = getSettings();

    $("#comfyinject_host").val(settings.comfy_host);
    $("#comfyinject_checkpoint").val(settings.checkpoint);
    $("#comfyinject_workflow").val(settings.workflow);
    $("#comfyinject_negative_prompt").val(settings.negative_prompt);
    $("#comfyinject_prepend_prompt").val(settings.prepend_prompt);
    $("#comfyinject_append_prompt").val(settings.append_prompt);
    $("#comfyinject_steps").val(settings.steps);
    $("#comfyinject_cfg").val(settings.cfg);
    $("#comfyinject_sampler").val(settings.sampler);
    $("#comfyinject_scheduler").val(settings.scheduler);
    $("#comfyinject_denoise").val(settings.denoise);
    $("#comfyinject_max_poll_attempts").val(settings.max_poll_attempts);
    $("#comfyinject_request_timeout_ms").val(settings.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS);

    // Local image saving
    $("#comfyinject_save_images_locally").prop("checked", settings.save_images_locally);
    $("#comfyinject_downscale_before_saving").prop("checked", settings.downscale_before_saving);
    $("#comfyinject_downscale_max_dimension").val(settings.downscale_max_dimension);
    $("#comfyinject_webp_quality").val(settings.webp_quality);
    $("#comfyinject_delete_images_with_chat").prop("checked", settings.delete_images_with_chat);
    updateSaveImagesUI(settings.save_images_locally, settings.downscale_before_saving);

    // Resolution lock
    $("#comfyinject_resolution_lock_enabled").prop("checked", settings.resolution_lock_enabled);
    $("#comfyinject_resolution_lock_width").val(settings.resolution_lock.width);
    $("#comfyinject_resolution_lock_height").val(settings.resolution_lock.height);
    updateResolutionLockUI(settings.resolution_lock_enabled);

    // Populate resolutions
    const resContainer = $("#comfyinject_resolutions");
    resContainer.empty();
    for (const [token, res] of Object.entries(settings.resolutions)) {
        const safeToken = escapeHtml(token);
        resContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${safeToken}</label>
                <input
                    type="number"
                    class="text_pole comfyinject-res-width"
                    data-token="${safeToken}"
                    value="${res.width}"
                    min="64"
                    max="2048"
                    step="64"
                    style="width: 70px;"
                />
                <span>&times;</span>
                <input
                    type="number"
                    class="text_pole comfyinject-res-height"
                    data-token="${safeToken}"
                    value="${res.height}"
                    min="64"
                    max="2048"
                    step="64"
                    style="width: 70px;"
                />
            </div>
        `);
    }

    // Shot lock
    $("#comfyinject_shot_lock_enabled").prop("checked", settings.shot_lock_enabled);
    const shotSelect = $("#comfyinject_shot_lock_value");
    shotSelect.empty();
    for (const token of Object.keys(settings.shot_tags)) {
        const safeToken = escapeHtml(token);
        shotSelect.append(`<option value="${safeToken}" ${token === settings.shot_lock ? "selected" : ""}>${safeToken}</option>`);
    }
    updateShotLockUI(settings.shot_lock_enabled);

    // Seed lock
    $("#comfyinject_seed_lock_enabled").prop("checked", settings.seed_lock_enabled);
    $("#comfyinject_seed_lock_mode").val(settings.seed_lock_mode);
    $("#comfyinject_seed_lock_value").val(settings.seed_lock_value);
    updateSeedLockUI(settings.seed_lock_enabled);

    // Marker repair notifications
    $("#comfyinject_repair_toast_mode").val(settings.repair_toast_mode || "failures");

    // Dedicated prompter
    populatePrompterUI();

    // Populate shot tags
    const shotContainer = $("#comfyinject_shot_tags");
    shotContainer.empty();
    for (const [token, tags] of Object.entries(settings.shot_tags)) {
        const safeToken = escapeHtml(token);
        shotContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${safeToken}</label>
                <input
                    type="text"
                    class="text_pole comfyinject-shot-tag"
                    data-token="${safeToken}"
                    value="${escapeHtml(tags)}"
                />
            </div>
        `);
    }
}

/**
 * Wires up the dedicated prompter block.
 */
function wirePrompterEvents() {
    // Block toggle
    $("#comfyinject_prompter_toggle").on("click", function () {
        $("#comfyinject_prompter_block").toggle();
        $(this).find(".comfyinject-disclosure-caret").toggleClass("down");
    });

    // Declarative fields
    for (const [selector, key, kind] of PROMPTER_FIELDS) {
        const event = kind === "checkbox" || kind === "select" ? "change" : "input";
        $(selector).on(event, function () {
            const settings = getSettings();
            if (kind === "checkbox") settings[key] = $(this).prop("checked");
            else if (kind === "int") settings[key] = intOr($(this).val(), defaultSettings[key]);
            else settings[key] = $(this).val();

            // A changed structured-output setting should retry a backend that
            // previously refused a schema.
            if (key === "prompter_structured_mode") resetTransportState();

            // The per-message prompter button only exists in dedicated and both
            // mode, so switching modes has to add or remove it right away.
            if (key === "trigger_mode") addDirectButtons();

            // Whether a prefill is actually sent depends on the structured mode,
            // and on there being something to send.
            if (key === "prompter_structured_mode" || key === "prompter_prefill") updatePrefillNote();

            // The two policies ship different TASK text, so a policy change has to
            // carry the instructions with it — but only when the field is still
            // pristine. An edited prompt is the user's, and silently rewriting it
            // is exactly the upgrade failure the Restore-default buttons exist to
            // avoid, so that case gets a note instead.
            if (key === "prompter_generate_policy") syncSystemPromptToPolicy();

            saveSettings();
        });
    }

    // Preset override
    $("#comfyinject_prompter_preset").on("change", function () {
        getSettings().prompter_preset = $(this).val();
        saveSettings();
    });

    // Restore-default buttons, one per editable prompt string
    for (const [button, field, key, resolveDefault, message] of PROMPTER_RESETS) {
        $(button).on("click", function () {
            const value = resolveDefault();
            getSettings()[key] = value;
            $(field).val(value);
            saveSettings();
            toastr.success(message, "ComfyInject");
        });
    }

    // Tools
    $("#comfyinject_prompter_preview_btn").on("click", function () {
        openContextPreview();
    });

    $("#comfyinject_prompter_test_btn").on("click", function () {
        openPrompterTest();
    });

    $("#comfyinject_prompter_appearance_btn").on("click", function () {
        openAppearanceEditor();
    });

    // Settings file
    $("#comfyinject_prompter_save_btn").on("click", function () {
        savePrompterSettingsToFile();
    });

    $("#comfyinject_prompter_load_btn").on("click", function () {
        loadPrompterSettingsFromFile();
    });
}

/**
 * Wires up all input event listeners.
 */
function wireEvents() {
    // Host
    $("#comfyinject_host").on("input", function () {
        getSettings().comfy_host = $(this).val();
        saveSettings();
    });

    // Checkpoint — text input
    $("#comfyinject_checkpoint").on("input", function () {
        getSettings().checkpoint = $(this).val();
        saveSettings();
    });

    // Checkpoint — arrow button toggles dropdown
    $("#comfyinject_checkpoint_arrow").on("click", function () {
        const dropdown = $("#comfyinject_checkpoint_dropdown");
        if (dropdown.children().length === 0) {
            // No checkpoints fetched yet — trigger a fetch
            refreshCheckpointList(true).then(() => {
                if ($("#comfyinject_checkpoint_dropdown").children().length > 0) {
                    dropdown.show();
                }
            });
        } else {
            dropdown.toggle();
        }
    });

    // Checkpoint — clicking an option fills the text input and closes the dropdown
    $("#comfyinject_checkpoint_dropdown").on("click", ".comfyinject-checkpoint-option", function () {
        const value = $(this).data("value");
        $("#comfyinject_checkpoint").val(value);
        getSettings().checkpoint = value;
        saveSettings();
        $("#comfyinject_checkpoint_dropdown").hide();
    });

    // Checkpoint — hover highlight
    $("#comfyinject_checkpoint_dropdown").on("mouseenter", ".comfyinject-checkpoint-option", function () {
        $(this).css("background", "var(--SmartThemeQuoteColor)");
    }).on("mouseleave", ".comfyinject-checkpoint-option", function () {
        $(this).css("background", "");
    });

    // Close dropdown when clicking outside
    $(document).on("click", function (e) {
        if (!$(e.target).closest("#comfyinject_checkpoint_arrow, #comfyinject_checkpoint_dropdown").length) {
            $("#comfyinject_checkpoint_dropdown").hide();
        }
    });

    // Workflow — debounced validation after typing stops
    let workflowValidateTimer = null;
    $("#comfyinject_workflow").on("input", function () {
        getSettings().workflow = $(this).val();
        saveSettings();

        // Debounce — validate 1.5s after the user stops typing
        clearTimeout(workflowValidateTimer);
        workflowValidateTimer = setTimeout(() => {
            validateWorkflow($(this).val());
        }, 1500);
    });

    // Negative prompt
    $("#comfyinject_negative_prompt").on("input", function () {
        getSettings().negative_prompt = $(this).val();
        saveSettings();
    });

    // Prepend prompt
    $("#comfyinject_prepend_prompt").on("input", function () {
        getSettings().prepend_prompt = $(this).val();
        saveSettings();
    });

    // Append prompt
    $("#comfyinject_append_prompt").on("input", function () {
        getSettings().append_prompt = $(this).val();
        saveSettings();
    });

    // Steps
    $("#comfyinject_steps").on("input", function () {
        getSettings().steps = intOr($(this).val(), defaultSettings.steps);
        saveSettings();
    });

    // CFG
    $("#comfyinject_cfg").on("input", function () {
        getSettings().cfg = floatOr($(this).val(), defaultSettings.cfg);
        saveSettings();
    });

    // Sampler
    $("#comfyinject_sampler").on("input", function () {
        getSettings().sampler = $(this).val();
        saveSettings();
    });

    // Scheduler
    $("#comfyinject_scheduler").on("input", function () {
        getSettings().scheduler = $(this).val();
        saveSettings();
    });

    // Denoise
    $("#comfyinject_denoise").on("input", function () {
        getSettings().denoise = floatOr($(this).val(), defaultSettings.denoise);
        saveSettings();
    });

    // Max poll attempts
    $("#comfyinject_max_poll_attempts").on("input", function () {
        getSettings().max_poll_attempts = intOr($(this).val(), defaultSettings.max_poll_attempts);
        saveSettings();
    });

    // Request timeout — an unparseable, empty or non-positive field falls back to
    // the default rather than storing NaN, which would disable every deadline at once.
    $("#comfyinject_request_timeout_ms").on("input", function () {
        const value = intOr($(this).val(), 0);
        getSettings().request_timeout_ms = value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
        saveSettings();
    });

    // Local image saving — toggle
    $("#comfyinject_save_images_locally").on("change", function () {
        const settings = getSettings();
        settings.save_images_locally = $(this).prop("checked");
        updateSaveImagesUI(settings.save_images_locally, settings.downscale_before_saving);
        saveSettings();
    });

    // Local image saving — downscale toggle
    $("#comfyinject_downscale_before_saving").on("change", function () {
        const settings = getSettings();
        settings.downscale_before_saving = $(this).prop("checked");
        updateSaveImagesUI(settings.save_images_locally, settings.downscale_before_saving);
        saveSettings();
    });

    // Local image saving — delete images with their chat
    $("#comfyinject_delete_images_with_chat").on("change", function () {
        getSettings().delete_images_with_chat = $(this).prop("checked");
        saveSettings();
    });

    // Local image saving — max dimension
    $("#comfyinject_downscale_max_dimension").on("input", function () {
        getSettings().downscale_max_dimension = intOr($(this).val(), defaultSettings.downscale_max_dimension);
        saveSettings();
    });

    // Local image saving — WebP quality
    $("#comfyinject_webp_quality").on("input", function () {
        getSettings().webp_quality = intOr($(this).val(), defaultSettings.webp_quality);
        saveSettings();
    });

    // Resolution lock — toggle
    $("#comfyinject_resolution_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().resolution_lock_enabled = locked;
        updateResolutionLockUI(locked);
        saveSettings();
    });

    // Resolution lock — width
    $("#comfyinject_resolution_lock_width").on("input", function () {
        getSettings().resolution_lock.width = intOr($(this).val(), defaultSettings.resolution_lock.width);
        saveSettings();
    });

    // Resolution lock — height
    $("#comfyinject_resolution_lock_height").on("input", function () {
        getSettings().resolution_lock.height = intOr($(this).val(), defaultSettings.resolution_lock.height);
        saveSettings();
    });

    // Resolutions — width
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-width", function () {
        const token = $(this).data("token");
        const current = getSettings().resolutions[token].width;
        getSettings().resolutions[token].width = intOr($(this).val(), current);
        saveSettings();
    });

    // Resolutions — height
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-height", function () {
        const token = $(this).data("token");
        const current = getSettings().resolutions[token].height;
        getSettings().resolutions[token].height = intOr($(this).val(), current);
        saveSettings();
    });

    // Shot lock — toggle
    $("#comfyinject_shot_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().shot_lock_enabled = locked;
        updateShotLockUI(locked);
        saveSettings();
    });

    // Shot lock — dropdown
    $("#comfyinject_shot_lock_value").on("change", function () {
        getSettings().shot_lock = $(this).val();
        saveSettings();
    });

    // Shot tags
    $("#comfyinject_shot_tags").on("input", ".comfyinject-shot-tag", function () {
        const token = $(this).data("token");
        getSettings().shot_tags[token] = $(this).val();
        saveSettings();
    });

    // Gallery button
    $("#comfyinject_gallery_btn").on("click", function () {
        openGallery();
    });

    // Advanced settings toggle
    $("#comfyinject_advanced_toggle").on("click", function () {
        $("#comfyinject_advanced_block").toggle();
        $(this).find(".comfyinject-disclosure-caret").toggleClass("down");
    });

    // Resolutions toggle
    $("#comfyinject_resolutions_toggle").on("click", function () {
        $("#comfyinject_resolutions_block").toggle();
    });

    // Shot tags toggle
    $("#comfyinject_shot_tags_toggle").on("click", function () {
        $("#comfyinject_shot_tags_block").toggle();
    });

    // Seed lock block toggle
    $("#comfyinject_seed_lock_toggle").on("click", function () {
        $("#comfyinject_seed_lock_block").toggle();
    });


    // Seed lock — toggle
    $("#comfyinject_seed_lock_enabled").on("change", function () {
        const locked = $(this).prop("checked");
        getSettings().seed_lock_enabled = locked;
        updateSeedLockUI(locked);
        saveSettings();
    });

    // Seed lock — mode dropdown
    $("#comfyinject_seed_lock_mode").on("change", function () {
        getSettings().seed_lock_mode = $(this).val();
        // Show/hide the custom seed input based on mode
        $("#comfyinject_seed_lock_custom_input").toggle($(this).val() === "CUSTOM");
        saveSettings();
    });

    // Seed lock — custom value
    $("#comfyinject_seed_lock_value").on("input", function () {
        getSettings().seed_lock_value = intOr($(this).val(), defaultSettings.seed_lock_value);
        saveSettings();
    });

    // Marker repair notifications
    $("#comfyinject_repair_toast_mode").on("change", function () {
        getSettings().repair_toast_mode = $(this).val();
        saveSettings();
    });

    // Dedicated prompter
    wirePrompterEvents();

    // Reset button — resets the advanced settings only, so everything
    // outside the Advanced block is preserved
    $("#comfyinject_reset").on("click", function () {
        const settings = getSettings();
        const {
            comfy_host,
            checkpoint,
            workflow,
            save_images_locally,
            downscale_before_saving,
            downscale_max_dimension,
            webp_quality,
            delete_images_with_chat,
        } = settings;

        // The Dedicated Prompter block lives outside Advanced, so its settings —
        // including the selected connection profile and any edited instructions —
        // survive this button the same way the connection settings do.
        const prompterKeys = Object.keys(settings).filter(
            (key) => key === "trigger_mode" || key.startsWith("prompter_")
        );
        const prompterValues = {};
        for (const key of prompterKeys) {
            prompterValues[key] = structuredClone(settings[key]);
        }

        // Reset to defaults
        Object.assign(settings, structuredClone(defaultSettings));

        // Restore connection settings
        settings.comfy_host = comfy_host;
        settings.checkpoint = checkpoint;
        settings.workflow = workflow;

        // Restore local image saving settings
        settings.save_images_locally = save_images_locally;
        settings.downscale_before_saving = downscale_before_saving;
        settings.downscale_max_dimension = downscale_max_dimension;
        settings.webp_quality = webp_quality;
        settings.delete_images_with_chat = delete_images_with_chat;

        // Restore dedicated prompter settings
        Object.assign(settings, prompterValues);

        saveSettings();
        populateUI();

        toastr.success("Advanced settings reset to defaults!", "ComfyInject");
    });
}

/**
 * Adds a "ComfyInject Registry" entry to SillyTavern's global extensions menu
 * (the magic wand in the top bar). That menu is browser chrome, not chat
 * content, so the sanitizer constraint on per-message buttons does not apply.
 * Null-probes the menu and degrades silently — an implicit core contract.
 * Idempotent via the id check, so re-init cannot double-inject.
 */
function addWandMenuItem() {
    const menu = document.getElementById("extensionsMenu");
    if (!menu || document.getElementById("comfyinject_wand_registry")) return;
    const item = document.createElement("div");
    item.id = "comfyinject_wand_registry";
    item.className = "list-group-item flex-container flexGap5";
    item.innerHTML = '<div class="fa-fw fa-solid fa-user-pen"></div><span>ComfyInject Registry</span>';
    item.addEventListener("click", () => {
        // ST does not close its own dropdown on an outside click to the item;
        // official extensions close it themselves.
        const dropdown = item.closest(".dropdown-menu")?.parentElement;
        if (dropdown) {
            dropdown.classList.remove("open");
            const toggle = dropdown.querySelector("[data-toggle='dropdown']");
            if (toggle?.setAttribute) toggle.setAttribute("aria-expanded", "false");
        }
        openAppearanceEditor();
    });
    menu.appendChild(item);
}

/**
 * Loads the settings HTML and initializes the UI.
 * Called once from index.js on load.
 */
export async function initUI() {
    injectStyle("comfyinject-settings-styles", SETTINGS_CSS);
    const settingsHtml = await $.get(`/${EXTENSION_FOLDER}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    populateUI();
    wireEvents();
    addWandMenuItem();

    // Silently try to populate the checkpoint list on load — no toast if ComfyUI isn't running
    refreshCheckpointList(false);
}