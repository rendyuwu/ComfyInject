// Default settings for ComfyInject
// These are loaded into SillyTavern's extension settings panel.
// DO NOT CHANGE THESE VALUES HERE. Instead, change them in the UI.

// The shipped default for every editable prompter string lives in one place, so
// each one has exactly one copy: `defaultSettings` below and the matching
// "Restore default" button in the UI both read it from there. Re-exported so
// every module keeps importing prompter defaults from settings.js.
import {
    DEFAULT_PROMPTER_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE,
    DEFAULT_PROMPTER_EXAMPLE_PROMPT,
    DEFAULT_PROMPTER_USER_TURN,
    DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS,
    DEFAULT_PROMPTER_SEED_USER_TURN,
} from "./src/prompter/defaults.js";

export {
    DEFAULT_PROMPTER_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SYSTEM_PROMPT_JUDGE,
    DEFAULT_PROMPTER_EXAMPLE_PROMPT,
    DEFAULT_PROMPTER_USER_TURN,
    DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT,
    DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS,
    DEFAULT_PROMPTER_SEED_USER_TURN,
};

export const MODULE_NAME = "comfyinject";

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

    // --- Request Timeout ---
    // Deadline for a single network request, in milliseconds. This bounds the
    // time one fetch may hang, which max_poll_attempts does not: it only counts
    // polls. Image downloads and uploads get at least 60 seconds regardless,
    // since they move real bytes.
    request_timeout_ms: 30000,

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

    // "always" = the schema JSON is always restated in OUTPUT RULES
    // "auto"   = it is omitted while the backend is enforcing the schema itself,
    //            and the prompt is rebuilt with it if the backend refuses
    // The prose rules and the worked example are sent either way.
    prompter_rules_verbosity: "always",

    // "always" = every character message is illustrated; the prompter only
    //            decides what to draw
    // "judge"  = the prompter decides whether the moment deserves an image
    // Switching this also switches which shipped default the Prompter
    // Instructions Restore-default button writes.
    prompter_generate_policy: "always",

    // How many recent messages before the target message to show the prompter.
    // Small on purpose: with the generate policy on "always" nothing needs a
    // wide window to judge scene changes, and history is the largest volatile
    // part of every request.
    prompter_history_count: 6,

    // Hold the history window's start still for this many messages at a time
    // instead of sliding it by one every turn, so the rendered history is
    // append-only between jumps and a cached prefix survives. 0 = slide.
    prompter_history_anchor: 0,

    // Quote this many previously generated image prompts back to the prompter as
    // the PREVIOUS IMAGES section, so clothing, clothing state, accessories and injuries
    // carry across images instead of reverting to the registry's outfit. 0 = off,
    // clamped to 3.
    //
    // Off by default because showing a model its last answer is the standard way
    // to make it repeat itself: the section is worth a real trade, not a free win.
    // Marker mode has had this channel since before the dedicated path existed —
    // outbound.js rewrites saved tags back into the main model's context — so this
    // is dedicated mode catching up rather than new ground.
    prompter_previous_image_count: 0,

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

    // Hard cap on comma-separated tags per image prompt, enforced after the
    // reply comes back rather than asked for in the prompt — a small model is
    // also a poorly-instruction-following one. 0 = off.
    // Only bounds what the prompter writes: prepend_prompt, the shot tag and
    // append_prompt are added afterwards and are not counted.
    prompter_max_tags: 0,

    // Comma-separated tags the prompter may not write. Stated in OUTPUT RULES and
    // enforced in both validators, so a tag banned here can neither reach ComfyUI
    // nor enter the appearance registry. Matched as whole tags on a normalized
    // fingerprint, so a ban on `hand_holding` also catches `hand holding`.
    //
    // Not the same tool as negative_prompt: that is negative conditioning handed
    // to the image model, this stops the text model writing the tag at all. For a
    // composition tag like `2girls` on a one-figure checkpoint, the negative
    // prompt is the weaker of the two.
    prompter_banned_tags: "",

    prompter_system_prompt: DEFAULT_PROMPTER_SYSTEM_PROMPT,

    // Rendered as the CONSTRAINTS section, in the cacheable half of the request
    // immediately after TASK. Omitted when empty.
    //
    // This is where a property of the user's *renderer* goes — "this checkpoint
    // renders one figure only" — as opposed to a property of their story, which is
    // TASK's business. Separate from prompter_final_instructions by cost and
    // position rather than by purpose: long standing text belongs in the cached
    // prefix, a short override that has to win belongs last.
    prompter_constraints: "",

    // The `prompt` string in the filled example inside OUTPUT RULES. An example
    // of a good reply outweighs prose about what a good reply looks like, so
    // this is the field to shorten for a checkpoint that can only draw simple
    // scenes.
    prompter_example_prompt: DEFAULT_PROMPTER_EXAMPLE_PROMPT,

    // Rendered as the last section, after OUTPUT RULES. Omitted when empty.
    // The only user-owned text in the recency-strong position, which is what
    // makes it the right slot for a rule that has to beat a shipped default.
    prompter_final_instructions: "",

    // The user message that asks for the reply.
    prompter_user_turn: DEFAULT_PROMPTER_USER_TURN,

    // Assistant prefill. Only the generateRaw transport supports one, and it is
    // never sent while native structured output is active — the backend is
    // already constrained, so a prefill is redundant at best.
    prompter_prefill: "",

    // Include the per-chat appearance registry in the prompter's context, so the
    // same character keeps the same hair, eyes and outfit across images.
    prompter_appearance_enabled: true,

    // "all"     = inject every registry entry on every request
    // "present" = inject only the cast plus characters named in the target
    //             message or the history window
    // "present" saves tokens in a chat with many discovered NPCs, at the cost of
    // dropping anyone referred to only by pronoun. It also moves the registry
    // into the volatile half of the request, which forfeits prompt caching.
    prompter_appearance_scope: "all",

    // Spend one extra LLM call on the first dedicated run in a chat, reading the
    // character cards and every bound lorebook to fill the registry. With this
    // off the registry still grows from generated images and can still be
    // seeded by hand from the registry editor.
    prompter_appearance_autoseed: true,

    // The seeding pass is a second LLM call with its own job, so it gets its own
    // instructions, its own example, its own last word and its own user turn
    // rather than sharing the directive pass's. A standing framing usually belongs in
    // both: the seeding pass runs first, and a refusal there leaves the registry
    // empty, which degrades every image after it.
    prompter_seed_system_prompt: DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT,
    prompter_seed_example_tags: DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS,
    prompter_seed_final_instructions: "",
    prompter_seed_user_turn: DEFAULT_PROMPTER_SEED_USER_TURN,

    // How many of this chat's own messages the seeding pass reads, on top of the
    // cards and the lorebooks. 0 = off, which is the pre-Phase-11 behaviour: a
    // registry derived from the card alone, and therefore byte-identical in every
    // chat that character is ever in. Non-zero is what lets two chats on the same
    // card disagree about who is in them and what they are wearing.
    prompter_seed_history_count: 20,

    // Include the Summarize extension's running summary in the seeding pass. It is
    // the only thing that reaches past the seeding history window in a long chat.
    prompter_seed_include_summary: true,

    // Re-run the seeding pass once the chat has grown by this many messages since
    // the last one, so a registry seeded from a greeting is not the registry a
    // chat is stuck with forty messages later. 0 = seed once per chat and never
    // again. Costs one LLM call per interval; hand-edited entries are never
    // touched by it.
    prompter_seed_refresh_messages: 30,

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