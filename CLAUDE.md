# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ComfyInject is a **SillyTavern third-party extension** — browser-side vanilla ES modules loaded directly by SillyTavern at runtime. It generates images in chat via a local ComfyUI instance.

There is **no build step, no package.json, no dependency manager, no test runner, and no CI**. `manifest.json` points SillyTavern at `index.js`, which imports everything else as native ES modules. Source comments in `src/imgtag.js`, `src/prompter/tags.js` and `src/prompter/schema.js` refer to "node smoke tests" — those tests are not checked into this repo; the comments explain *why* those modules avoid SillyTavern access, and that constraint should still be honoured.

## Development workflow

Install by cloning (or symlinking) the repo to:

```
SillyTavern/public/scripts/extensions/third-party/ComfyInject
```

`EXTENSION_FOLDER` is hardcoded to that path in `src/comfy.js` and `src/ui.js` — the folder name must be exactly `ComfyInject` or workflow loading and `settings.html` fetching break.

To iterate: edit files, then hard-refresh the SillyTavern browser tab. There is nothing to compile or restart. Verification is manual:

- Browser console — every module logs with a `[ComfyInject]` prefix. `index.js` prints `Loading...` then `Ready!`.
- Extensions panel → ComfyInject → **Dedicated Prompter** → **Debug logging** turns on `[ComfyInject/prompter]` output: the assembled prompt in full, both block sizes, and whether the cached system prefix was byte-identical to the previous request.
- **Preview Context** button — renders the exact prompter payload section by section without spending a token. This is the first place to look at any prompter change.
- **Test Prompter** button — one real LLM request, no image generated.
- ComfyUI must be launched with `--enable-cors-header` or every request fails at the browser.

Bump `manifest.json`'s `version` when shipping a user-visible change.

Commit subjects follow conventional-commit types (`feat`, `fix`, `refactor`, `docs`, `chore`) with an optional `(prompter)` / `(ui)` scope, and a lowercase prose description of intent rather than of the diff.

## Architecture

Two trigger paths produce an image directive; everything downstream is shared.

**Marker path** (`src/dom.js` → `src/parse.js`) — the roleplay model writes `[[IMG: prompt | AR | SHOT | SEED ]]`. `parse.js` is a lenient/repairing parser: it classifies control tokens by type rather than position, defaults missing fields, and records `repairMeta` that surfaces in the gallery.

**Dedicated path** (`src/prompter/director.js`) — a second LLM call reads the chat and returns a validated JSON directive. The roleplay model is never asked for markers.

```
index.js
  initLazyImages  → DOMPurify hook, lazy/async on every message <img>
  initUI          → fetches settings.html, binds settings
  initDom         → marker path listeners
  initDirector    → dedicated path listeners  (MUST be after initDom)
  initCleanup     → chat-delete/rename image cleanup
  import outbound → registers globalThis.comfyInjectInterceptor
```

`trigger_mode` is `"marker" | "dedicated" | "both"`. In `both` mode, registration order is load-bearing: SillyTavern's event emitter awaits `CHARACTER_MESSAGE_RENDERED` listeners in registration order, so the marker path runs first and the prompter stands down on a message that already has an image. **Do not reorder the `init*` calls in `index.js`.**

### Shared pipeline (both paths)

`comfy.js:generateImage()` → `queue.js:enqueue()` → fill workflow JSON → POST `/prompt` → poll `/history` → `save.js:saveImageLocally()` (download, downscale to WebP, upload into SillyTavern's own image storage) → `imgtag.js:buildImgTag()` → `dom.js:persistMessageImages()` → `cleanup.js:registerSavedImage()`.

`outbound.js` rewrites the chat *copy* sent to the roleplay model: `<img>` becomes `[[IMG: prompt | seed ]]` in marker/both mode, and is deleted outright in dedicated mode (a booru tag list in the model's own history is something it starts imitating). Failure placeholders are always stripped.

### Module ownership rules

These exist because each was violated once and broke something:

- **`src/imgtag.js` is the only place that reads or writes a ComfyInject `<img>` tag.** Never write another `/<img class="comfyinject-image"[^>]*>/` regex — the tag regex is quote-aware precisely because a prompt containing `<lora:x:1>` truncated the naive version. Use `parseImageTags` / `replaceImageTags` / `buildImgTag` / `countImageTags`.
- **`src/failtag.js` is the only place that reads or writes a failure placeholder.** Same reason. Both modules accept the sanitizer's optional `custom-` class prefix, so they work on `message.mes` and on rendered DOM alike.
- **`src/queue.js`** — every ComfyUI submission from every path goes through the one serial queue, so the marker path, prompter path and retry button can never collide.
- **`src/http.js`** — every network request carries a deadline. Control-plane requests use `requestTimeoutMs()`; anything moving image bytes uses `transferTimeoutMs()` (60s floor).
- **`src/notify.js`** — one gate for whether the extension may interrupt the user. Automatic paths honour `repair_toast_mode`; a user-initiated action always answers (`{ force: true }`).
- **`src/macros.js`** — expand macros at *render* time, on each editable string as it is placed into its section, never on the assembled prompt. World info, history and message text arrive already resolved by core; braces a character wrote in dialogue must survive.
- **`src/parse.js`** owns `VALID_AR` / `VALID_SHOT`. The prompter's JSON schema enums derive from those Sets so the two paths cannot drift.
- **`src/prompter/defaults.js`** holds every shipped prompter prose default, referenced exactly twice (by `defaultSettings` and by its **Restore default** button). Editing one changes behaviour for every install that has not edited that field — treat it as a behaviour change. Versioned fingerprint constants (`*_V8`, `*_V10`) exist only so upgrade migrations can tell an untouched field from a user-edited one; keep them out of `settings.js`'s export list.

### Chat state invariants

- **Image metadata is keyed by `send_date`**, not array index, and lives in `chatMetadata[MODULE_NAME]`. Numeric-index lookup is a legacy fallback only.
- **Metadata entry order must match `<img>` tag order in the message.** `retryImage()` and the gallery map a button to its metadata positionally. `persistMessageImages()` supports replace / append / `insertAt` for exactly this reason.
- **Re-resolve the message index after every `await`.** Messages shift while ComfyUI works; use `dom.js:findIndexBySendDate()` and bail if the message is gone.
- **`cleanup.js`'s `saved_images` registry is deliberately absent from `defaultSettings`**, so the settings Reset button does not orphan every image the extension ever saved.
- **Retry buttons and the per-message prompter wand are pure DOM injection, never persisted** — SillyTavern's sanitizer strips custom markup out of saved message text.
- **A `user` appearance-registry entry with no tags is a tombstone, not a bug.** It is the only durable way to refuse a name: deleting a row just invites the next seeding pass to rewrite it. `setRegistryEntry()` accepts an empty write only from `source: "user"`; `buildAppearanceSection()` skips it because it has no tags. This is what a card that is a world, a narrator or a game master rather than a person needs.
- **`setRegistryEntry()` is the only place a registry entry's character cap is applied.** `validateAppearanceReply()` and `distillAppearanceTags()` deliberately pass `maxChars: 0`. Capping twice means the second call sees text that already fits, so the entry gets stored as untruncated and the cut goes unreported — which was the original bug. The cap itself comes from `registryMaxChars()` (setting `prompter_registry_max_chars`, clamped 100–2000, default 800) and is stated to the seeding pass from the same function — a stated cap the writer is not held to is worse than none.

### Dedicated prompter internals (`src/prompter/`)

| File | Role |
|---|---|
| `director.js` | Orchestration, concurrency (one request at a time, re-entry dropped, `CHAT_CHANGED` aborts), manual wand button |
| `context.js` | Assembles the two-message payload from live SillyTavern state |
| `sources.js` | Read-only SillyTavern accessors shared by both prompter passes; `stripImages()` |
| `llm.js` | Transport: Connection Profile via `ConnectionManagerRequestService`, else `generateRaw`. Native structured output with per-profile refusal memory and prompt-engineered fallback |
| `schema.js` | The output contract — used as backend schema, as prompt text, and as validator |
| `appearance.js` | Per-chat appearance registry (`seed` / `grown` / `user` entries) in chat metadata |
| `tags.js` | Tag fingerprinting and banned-tag stripping, shared by both validators |
| `preview.js`, `appearance-ui.js`, `overlay.js` | The three settings-panel tools and their shared overlay |

Two structural decisions to preserve:

- **The request is split on the static/volatile line for prompt caching.** `messages[0]` (system) holds only what does not change between character messages; `messages[1]` (user) holds history, summary, world info and the target message. Moving a section across that line changes what a caching backend charges. `Registry Scope: Present` deliberately moves the registry to the volatile half.
- **The output contract lives in `OUTPUT RULES`, not in the user-editable Prompter Instructions**, so a user rewriting their instructions cannot delete the contract. The one relaxation is `prompter_allow_registry_lora`, which swaps the LoRA clause for "copied verbatim from the registry, never invented" and has `validateDirective()` re-insert a pinned call the model dropped — a setting and a mechanism, never a prose exception the user has to argue into `CONSTRAINTS`.

Prompter fields are bound declaratively through the `PROMPTER_FIELDS` table at the top of `src/ui.js` (`[selector, settings key, kind]`). Add a new prompter setting by adding a row there, a key in `defaultSettings`, and the markup in `settings.html` — not a bespoke handler.

New settings keys are merged key-by-key into saved settings on load (`index.js:initSettings`), so adding one is safe; changing the *meaning* of an existing one needs an explicit migration like `migrateSeedSystemPrompt`.

### SillyTavern integration constraints

- All core access goes through `SillyTavern.getContext()`. There are no static imports from SillyTavern core.
- Probe every optional core call with `typeof` so an older or newer SillyTavern degrades to a smaller prompt instead of throwing.
- World info is read in **dry-run mode** — the prompter must not disturb the roleplay's own sticky/cooldown/recursion state or emit `WORLD_INFO_ACTIVATED`.
- `updateMessageBlock()` can throw on some messages (ST's reasoning handler); every call to it here is wrapped in try/catch.

## Workflows

`workflows/comfyinject_default.json` is a ComfyUI API-format workflow with `"{{PLACEHOLDER}}"` strings. `comfy.js:fillWorkflow()` does a JSON-string substitution that replaces the quoted placeholder including its quotes, which is how typed values (integers, floats) get in. Supported placeholders and the positive-prompt composition order are documented in `workflows/workflows_README.md`.

Positive prompt is assembled as: Prepend Prompt, shot tags, the LLM's prompt, Append Prompt. Prepend/Append are added in `comfy.js` *after* the prompter is done, so **Banned tags** and **Max tags** do not apply to them.
