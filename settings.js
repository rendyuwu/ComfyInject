// Default settings for ComfyInject
// These are loaded into SillyTavern's extension settings panel.
// DO NOT CHANGE THESE VALUES HERE. Instead, change them in the UI.

export const MODULE_NAME = "comfyinject";

// Default system prompt for the dedicated prompter.
// Kept as its own export so the settings UI can offer a "Restore default" button
// without ever silently overwriting a prompt the user has edited.
export const DEFAULT_PROMPTER_SYSTEM_PROMPT = `You are ComfyInject's image director. You read one roleplay message and turn it into a prompt for a text-to-image model.

You never write prose, never continue the story, and never address the user. Your only output is the JSON object described in OUTPUT RULES.

Deciding whether to generate:
- Generate when the target message establishes or changes something visible: a new scene, a new character, a change of pose, outfit, expression, lighting or location, or a moment that is simply worth illustrating.
- Skip dialogue that changes nothing visible, skip meta or out-of-character talk, and skip anything that would only repeat the previous image.
- When in doubt, skip. A missing image costs nothing; a wrong one interrupts the scene.

Writing the prompt:
- Booru-style comma-separated tags, most important first. No sentences, no narration.
- Rough order: subject count and identity (1girl, 1boy, solo, 2girls), appearance, clothing, pose and expression, setting, lighting and mood.
- For any character listed in APPEARANCE REGISTRY, reuse their tags verbatim. Never invent hair, eye or outfit details that contradict the registry, the character card, or WORLD INFO.
- Describe only what is visible in frame.
- No seeds, no attention weights, no {{macros}}, no negative-prompt content, no LoRA or embedding calls. Negative prompt, prefix and suffix tags are added by the extension.
- Pick "ar" and "shot" from the allowed values only.`;

export const defaultSettings = Object.freeze({

    // --- ComfyUI Connection ---
    comfy_host: "http://127.0.0.1:8188",

    // --- Model ---
    // The filename of your checkpoint as it appears in ComfyUI's model list.
    // Example: "v1-5-pruned-emaonly.ckpt" or "dreamshaper_8.safetensors"
    checkpoint: "v1-5-pruned-emaonly-fp16.safetensors",

    // --- Workflow ---
    // The filename of the workflow JSON in the workflows folder.
    workflow: "comfyinject_default.json",

    // --- Local Image Saving ---
    // When enabled, generated images are copied into SillyTavern's own image
    // storage and the message links to that copy instead of to ComfyUI.
    // Chats then load without ComfyUI having to be reachable.
    save_images_locally: true,

    // Shrink and re-encode images to WebP before saving them.
    // A 1.8 MB PNG typically becomes well under 100 KB.
    downscale_before_saving: true,
    downscale_max_dimension: 1280,
    webp_quality: 82,

    // Delete a chat's saved images when the chat itself is deleted.
    // SillyTavern removes only the chat file, so images otherwise pile up
    // forever. Images that another chat still shows are always kept.
    delete_images_with_chat: true,

    // --- Negative Prompt ---
    negative_prompt: "worst quality, low quality, blurry, deformed, ugly, extra limbs",

    // --- Prepend Prompt ---
    // Custom tags prepended to every positive prompt before the LLM's output.
    prepend_prompt: "",

    // --- Append Prompt ---
    // Custom tags appended to every positive prompt after the LLM's output.
    append_prompt: "",

    // --- Sampler Settings ---
    steps: 24,
    cfg: 7.0,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0,

    // --- Polling ---
    // Maximum number of 1-second polls before giving up on an image.
    max_poll_attempts: 180,

    // --- Aspect Ratio Resolutions ---
    // Width x Height in pixels for each AR token the LLM can use.
    resolutions: {
        PORTRAIT:  { width: 512,  height: 768 },
        SQUARE:    { width: 512,  height: 512 },
        LANDSCAPE: { width: 768,  height: 512 },
        CINEMA:    { width: 768,  height: 432 },
    },

    // --- Resolution Lock ---
    // When enabled, ignores the LLM's AR token and uses this resolution for everything.
    resolution_lock_enabled: false,
    resolution_lock: { width: 512, height: 768 },

    // --- Shot Lock ---
    // When enabled, ignores the LLM's SHOT token and uses this shot type for everything.
    shot_lock_enabled: false,
    shot_lock: "MEDIUM",

    // --- Seed Lock ---
    // When enabled, ignores the LLM's SEED token and uses this seed mode for everything.
    // seed_lock_mode can be "RANDOM", "LOCK", or "CUSTOM".
    seed_lock_enabled: false,
    seed_lock_mode: "RANDOM",
    seed_lock_value: 0,

    // --- Marker Repair Notifications ---
    // Controls when parser repair toasts are shown.
    // "all" = successful repaired markers + parse failures
    // "failures" = parse failures only
    // "off" = no marker repair toasts
    repair_toast_mode: "failures",

    // --- Trigger Mode ---
    // How image generation is triggered.
    // "marker"    = the main roleplay model emits [[IMG: ...]] markers (the original behaviour)
    // "dedicated" = a separate LLM call reads the chat and decides
    // "both"      = markers first, dedicated prompter as a fallback
    trigger_mode: "marker",

    // --- Dedicated Prompter ---
    // Fire the prompter automatically on every character message.
    // When false, only the manual buttons run it.
    prompter_auto: true,

    // SillyTavern Connection Profile id. ComfyInject stores the id only —
    // model, endpoint and API key stay in SillyTavern.
    prompter_profile_id: "",

    // Optional completion preset override. Empty = use the profile's own preset.
    prompter_preset: "",

    prompter_max_tokens: 1024,
    prompter_timeout_ms: 60000,

    // "native" = ask the backend for schema-constrained JSON
    // "json"   = describe the schema in the prompt and parse the reply
    // Native degrades to json automatically when the backend rejects it.
    prompter_structured_mode: "native",

    // How many recent messages before the target message to show the prompter.
    prompter_history_count: 12,

    prompter_include_card: true,
    prompter_include_persona: true,
    prompter_include_author_note: false,
    prompter_include_summary: true,

    // "activated" = only lore entries SillyTavern would currently trigger
    // "off"       = no lore at all
    prompter_lore_mode: "activated",
    prompter_lore_max_chars: 4000,

    // Hard cap applied after validation, whatever the model returns.
    prompter_max_images_per_message: 1,

    prompter_system_prompt: DEFAULT_PROMPTER_SYSTEM_PROMPT,

    // Include the per-chat appearance registry in the prompter's context, so the
    // same character keeps the same hair, eyes and outfit across images.
    prompter_appearance_enabled: true,

    // Spend one extra LLM call on the first dedicated run in a chat, reading the
    // character cards and every bound lorebook to fill the registry. With this
    // off the registry still grows from generated images and can still be
    // seeded by hand from the registry editor.
    prompter_appearance_autoseed: true,

    // Log the assembled prompt and the raw response to the console.
    prompter_debug: false,

    // --- Shot Tags ---
    // Danbooru-style tags prepended to the positive prompt for each SHOT token.
    // Edit these to match your model's preferred framing vocabulary.
    shot_tags: {
        CLOSE:     "close-up, face focus",
        MEDIUM:    "upper body",
        WIDE:      "full body",
        DUTCH:     "dutch angle",
        OVERHEAD:  "from above, bird's eye view",
        LOWANGLE:  "from below",
        HIGHANGLE: "from above",
        PROFILE:   "profile, from side",
        BACKVIEW:  "from behind",
        POV:       "pov",
    },
});