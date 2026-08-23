import { MODULE_NAME, defaultSettings, DEFAULT_PROMPTER_SYSTEM_PROMPT } from "../settings.js";
import { openGallery } from "./gallery.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, requestTimeoutMs } from "./http.js";
import { openContextPreview, openPrompterTest } from "./prompter/preview.js";
import { openAppearanceEditor } from "./prompter/appearance-ui.js";
import { resetTransportState } from "./prompter/llm.js";
import { addDirectButtons } from "./prompter/director.js";

const EXTENSION_FOLDER = `scripts/extensions/third-party/ComfyInject`;

// Dedicated prompter fields, bound declaratively — one table instead of a
// second wall of near-identical handlers.
// [selector, settings key, kind]
const PROMPTER_FIELDS = [
    ["#comfyinject_trigger_mode", "trigger_mode", "select"],
    ["#comfyinject_prompter_structured_mode", "prompter_structured_mode", "select"],
    ["#comfyinject_prompter_lore_mode", "prompter_lore_mode", "select"],
    ["#comfyinject_prompter_max_tokens", "prompter_max_tokens", "int"],
    ["#comfyinject_prompter_timeout_ms", "prompter_timeout_ms", "int"],
    ["#comfyinject_prompter_history_count", "prompter_history_count", "int"],
    ["#comfyinject_prompter_lore_max_chars", "prompter_lore_max_chars", "int"],
    ["#comfyinject_prompter_max_images_per_message", "prompter_max_images_per_message", "int"],
    ["#comfyinject_prompter_auto", "prompter_auto", "checkbox"],
    ["#comfyinject_prompter_include_card", "prompter_include_card", "checkbox"],
    ["#comfyinject_prompter_include_persona", "prompter_include_persona", "checkbox"],
    ["#comfyinject_prompter_include_author_note", "prompter_include_author_note", "checkbox"],
    ["#comfyinject_prompter_include_summary", "prompter_include_summary", "checkbox"],
    ["#comfyinject_prompter_appearance_enabled", "prompter_appearance_enabled", "checkbox"],
    ["#comfyinject_prompter_appearance_autoseed", "prompter_appearance_autoseed", "checkbox"],
    ["#comfyinject_prompter_debug", "prompter_debug", "checkbox"],
    ["#comfyinject_prompter_system_prompt", "prompter_system_prompt", "text"],
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
            dropdown.append(
                `<div class="comfyinject-checkpoint-option" data-value="${name}" style="padding: 6px 10px; cursor: pointer; ${name === current ? "font-weight: bold;" : ""}">${name}</div>`
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
        select.append(`<option value="${profile.id}">${label}</option>`);
    }
    select.val(settings.prompter_profile_id || "");
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
        select.append(`<option value="${preset}">${preset}</option>`);
    }
    select.val(presets.includes(current) ? current : "");
}

/**
 * Populates the dedicated prompter fields from current settings.
 */
function populatePrompterUI() {
    const settings = getSettings();

    for (const [selector, key, kind] of PROMPTER_FIELDS) {
        if (kind === "checkbox") $(selector).prop("checked", !!settings[key]);
        else $(selector).val(settings[key] ?? "");
    }

    populatePrompterProfiles();
    populatePrompterPresets();
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
        resContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${token}</label>
                <input
                    type="number"
                    class="text_pole comfyinject-res-width"
                    data-token="${token}"
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
                    data-token="${token}"
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
        shotSelect.append(`<option value="${token}" ${token === settings.shot_lock ? "selected" : ""}>${token}</option>`);
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
        shotContainer.append(`
            <div class="flex-container flexGap5 alignItemsCenter" style="margin-bottom: 4px;">
                <label style="width: 80px;">${token}</label>
                <input
                    type="text"
                    class="text_pole comfyinject-shot-tag"
                    data-token="${token}"
                    value="${tags}"
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
    });

    // Declarative fields
    for (const [selector, key, kind] of PROMPTER_FIELDS) {
        const event = kind === "checkbox" || kind === "select" ? "change" : "input";
        $(selector).on(event, function () {
            const settings = getSettings();
            if (kind === "checkbox") settings[key] = $(this).prop("checked");
            else if (kind === "int") settings[key] = parseInt($(this).val(), 10);
            else settings[key] = $(this).val();

            // A changed structured-output setting should retry a backend that
            // previously refused a schema.
            if (key === "prompter_structured_mode") resetTransportState();

            // The per-message prompter button only exists in dedicated and both
            // mode, so switching modes has to add or remove it right away.
            if (key === "trigger_mode") addDirectButtons();

            saveSettings();
        });
    }

    // Connection profile — only bound for the manual fallback list.
    // handleDropdown owns its own change handler when it is available.
    $("#comfyinject_prompter_profile_id").on("change", function () {
        const value = $(this).val();
        if (getSettings().prompter_profile_id === value) return;
        getSettings().prompter_profile_id = value;
        resetTransportState();
        saveSettings();
    });

    // Preset override
    $("#comfyinject_prompter_preset").on("change", function () {
        getSettings().prompter_preset = $(this).val();
        saveSettings();
    });

    // Restore the default prompter instructions
    $("#comfyinject_prompter_system_prompt_reset").on("click", function () {
        getSettings().prompter_system_prompt = DEFAULT_PROMPTER_SYSTEM_PROMPT;
        $("#comfyinject_prompter_system_prompt").val(DEFAULT_PROMPTER_SYSTEM_PROMPT);
        saveSettings();
        toastr.success("Default prompter instructions restored.", "ComfyInject");
    });

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
        getSettings().steps = parseInt($(this).val(), 10);
        saveSettings();
    });

    // CFG
    $("#comfyinject_cfg").on("input", function () {
        getSettings().cfg = parseFloat($(this).val());
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
        getSettings().denoise = parseFloat($(this).val());
        saveSettings();
    });

    // Max poll attempts
    $("#comfyinject_max_poll_attempts").on("input", function () {
        getSettings().max_poll_attempts = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Request timeout — an unparseable or empty field falls back to the default
    // rather than storing NaN, which would disable every deadline at once.
    $("#comfyinject_request_timeout_ms").on("input", function () {
        const value = parseInt($(this).val(), 10);
        getSettings().request_timeout_ms = Number.isFinite(value) && value > 0
            ? value
            : DEFAULT_REQUEST_TIMEOUT_MS;
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
        getSettings().downscale_max_dimension = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Local image saving — WebP quality
    $("#comfyinject_webp_quality").on("input", function () {
        getSettings().webp_quality = parseInt($(this).val(), 10);
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
        getSettings().resolution_lock.width = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolution lock — height
    $("#comfyinject_resolution_lock_height").on("input", function () {
        getSettings().resolution_lock.height = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolutions — width
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-width", function () {
        const token = $(this).data("token");
        getSettings().resolutions[token].width = parseInt($(this).val(), 10);
        saveSettings();
    });

    // Resolutions — height
    $("#comfyinject_resolutions").on("input", ".comfyinject-res-height", function () {
        const token = $(this).data("token");
        getSettings().resolutions[token].height = parseInt($(this).val(), 10);
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
        getSettings().seed_lock_value = parseInt($(this).val(), 10);
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
 * Loads the settings HTML and initializes the UI.
 * Called once from index.js on load.
 */
export async function initUI() {
    const settingsHtml = await $.get(`/${EXTENSION_FOLDER}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    populateUI();
    wireEvents();

    // Silently try to populate the checkpoint list on load — no toast if ComfyUI isn't running
    refreshCheckpointList(false);
}