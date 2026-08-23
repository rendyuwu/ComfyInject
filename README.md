<a id="readme-top"></a>

# ComfyInject

A SillyTavern extension that automatically generates images inside your chat using your local ComfyUI instance.

There are two ways to trigger a generation, chosen with **Trigger Mode** in the settings:

- **Marker mode** (the default, and the original behaviour) — your roleplay model writes a `[[IMG: ... ]]` marker into its message. ComfyInject intercepts it, sends the prompt to ComfyUI, and replaces the marker with the generated image.
- **Dedicated mode** — a second, separate LLM call reads the chat, decides on its own whether the moment is worth illustrating, and returns a structured image prompt. The roleplay model is never asked to emit markers at all. See [Dedicated Prompter](#dedicated-prompter).

Everything after the prompt is shared by both modes. Multiple images per message are supported. Images are saved permanently into the chat history and survive page reloads. By default each image is also copied into SillyTavern's own image storage, so chats keep loading even when ComfyUI is switched off. Outbound prompts sent to the LLM replace injected images with a compact text token so the model keeps visual continuity across the conversation.

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#requirements">Requirements</a></li>
    <li>
      <a href="#installation">Installation</a>
      <ul>
        <li><a href="#step-1--install-the-extension">Step 1 — Install the extension</a></li>
        <li><a href="#step-2--enable-the-cors-header-in-comfyui">Step 2 — Enable the CORS header in ComfyUI</a></li>
        <li><a href="#step-3--configure-the-extension">Step 3 — Configure the extension</a></li>
        <li><a href="#step-4--choose-how-generations-are-triggered">Step 4 — Choose how generations are triggered</a></li>
      </ul>
    </li>
    <li><a href="#configuration">Configuration</a></li>
    <li><a href="#marker-format">Marker Format</a></li>
    <li><a href="#system-prompt">System Prompt</a></li>
    <li>
      <a href="#dedicated-prompter">Dedicated Prompter</a>
      <ul>
        <li><a href="#turning-it-on">Turning it on</a></li>
        <li><a href="#what-the-prompter-sees">What the prompter sees</a></li>
        <li><a href="#appearance-registry">Appearance Registry</a></li>
        <li><a href="#the-three-tool-buttons">The three tool buttons</a></li>
        <li><a href="#both-mode">Both mode</a></li>
      </ul>
    </li>
    <li><a href="#image-gallery">Image Gallery</a></li>
    <li><a href="#retry-button">Retry Button</a></li>
    <li><a href="#local-image-saving">Local Image Saving</a></li>
    <li><a href="#custom-workflows">Custom Workflows</a></li>
    <li><a href="#how-it-works">How It Works</a></li>
    <li><a href="#known-limitations">Known Limitations</a></li>
    <li><a href="#faq">FAQ</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- A local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance
> Tested on SillyTavern **1.16** (latest stable release) and staging. Should work on any recent version.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Installation

### Step 1 — Install the extension

**Option A — ST's built-in installer (recommended):**
1. Open the Extensions panel in SillyTavern
2. Click **Install extension** and paste in the repo URL:
   ```
   https://github.com/Spadic21/ComfyInject
   ```

**Option B — Git (command line):**
1. Navigate to your SillyTavern root directory in File Explorer, click the address bar, type cmd and press Enter. This opens a command prompt directly in that folder.
2. Paste this command in there:
```
git clone https://github.com/Spadic21/ComfyInject "public/scripts/extensions/third-party/ComfyInject"
```

**Option C — Manual download:**
Download this repo as a ZIP, unzip it, and place the folder here:
```
SillyTavern/
└── public/
    └── scripts/
        └── extensions/
            └── third-party/
                └── ComfyInject/  ← here
```

---

### Step 2 — Enable the CORS header in ComfyUI

ComfyInject needs to talk to ComfyUI from the browser, which requires CORS to be enabled.

**If you use the ComfyUI Desktop app:**
Open ComfyUI → Settings → **Server-Config** → enable the CORS header option. You'll see `--enable-cors-header *` appear at the top when it's active. The `*` allows all origins — you can restrict it to `http://127.0.0.1:8000` if you prefer, or whatever domain you use for your ST session.

**If you use the portable package:**
Open `run_nvidia_gpu.bat` (or whichever `.bat` file you use) in a text editor.
Find the line that starts with `.\python_embeded\python.exe`
Add `--enable-cors-header` to the end of that line. It should look like this:
```
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --enable-cors-header
```

**If you use the manual install:**
Launch ComfyUI with the flag:
```
python main.py --enable-cors-header
```

---

### Step 3 — Configure the extension

Before ComfyInject can generate anything, two settings **must** be configured. Open the Extensions panel in SillyTavern, find ComfyInject, and set:

- **ComfyUI Host** — the URL of your ComfyUI instance. Default is `http://127.0.0.1:8188` which is correct for most local installs. Change this if you're running ComfyUI on a different port or machine.
- **Checkpoint** — the filename of your model **exactly** as it appears in ComfyUI's model list and model folder. Example: `waiIllustriousSDXL_v160.safetensors`. You can click the dropdown arrow next to the text field to fetch and select from your available checkpoints directly. Not sure where to find this? See the [FAQ](#how-do-i-find-my-checkpoint-filename-in-comfyui).

All other settings have sensible defaults and don't need to be changed to get started. See the [Configuration](#configuration) section for the full list.

---

### Step 4 — Choose how generations are triggered

**Marker mode (the default).** ComfyInject won't generate anything unless your LLM knows to output the `[[IMG: ... ]]` marker format.

- **To get up and running fast:** copy the ready-made prompt from the [System Prompt](#system-prompt) section and paste it into your character's Post-History Instructions (Author's Note in ST).
- **To write your own:** see the [Marker Format](#marker-format) section for the recommended format and parser behavior.

**Dedicated mode.** Nothing goes into your Post-History Instructions at all — in fact the marker instruction block should be removed. Instead, open the **Dedicated Prompter** panel in the extension settings, set **Trigger Mode** to *Dedicated*, and pick a **Connection Profile** for the prompter to use. See [Dedicated Prompter](#dedicated-prompter).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Configuration

All settings are available in the Extensions panel in SillyTavern under **ComfyInject**. The required settings and the image storage options are visible immediately. The prompter settings are under **Dedicated Prompter**, and everything else is under **Advanced Settings**.

### Connection & Model

| Setting | Description |
|---|---|
| `ComfyUI Host` | URL of your ComfyUI instance. Default: `http://127.0.0.1:8188` |
| `Checkpoint` | Filename of your model as it appears in ComfyUI. Must match exactly. Click the dropdown arrow to fetch available checkpoints. |
| `Workflow` | Filename of the workflow JSON in the `workflows/` folder. Default: `comfyinject_default.json`. Validated automatically after you stop typing. |

### Local Image Saving

These options sit directly under the Checkpoint and Workflow fields — they are not part of Advanced Settings. See [Local Image Saving](#local-image-saving) for the full behaviour.

| Setting | Description |
|---|---|
| `Save generated images to SillyTavern` | Copy each generated image into SillyTavern's own storage and link the message to that copy instead of to ComfyUI. Default: on. Turn it off to go back to hotlinking ComfyUI's `/view` endpoint. |
| `Downscale before saving` | Shrink and re-encode to WebP before saving. Default: on. |
| `Max dimension` | Longest edge in pixels after downscaling. Images already smaller are re-encoded but never enlarged. Default: 1280. |
| `Quality` | WebP quality, 1-100. Default: 82. |
| `Delete images when their chat is deleted` | Delete a chat's saved images when the chat itself is deleted. Images another chat still shows are always kept. Default: on. |

### Dedicated Prompter Settings

Its own collapsible panel, above Advanced Settings. See [Dedicated Prompter](#dedicated-prompter) for what the mode actually does.

| Setting | Description |
|---|---|
| `Trigger Mode` | `Marker` (default), `Dedicated`, or `Both`. Marker mode is byte-identical to the behaviour before this feature existed. |
| `Connection Profile` | Which SillyTavern Connection Profile the prompter calls. ComfyInject stores the profile id only — model, endpoint and API key stay in SillyTavern. With nothing selected, the currently active main API is used instead. |
| `Preset Override` | Optional completion preset for the prompter call only. Empty = use the profile's own preset. The override is always restored afterwards, so your profile is never left modified. |
| `Structured Output` | `Native` asks the backend to enforce the JSON schema. `Prompt-engineered` describes the schema in the prompt instead. Native falls back to prompt-engineered on its own if the backend refuses. |
| `Max Tokens` | Response budget for the prompter call. Default: 1024. Reasoning models may need more — a reply that runs out of budget mid-thought produces no image. |
| `Timeout (ms)` | Hard timeout per prompter call. Default: 60000. |
| `Run automatically on new messages` | Fire the prompter on every character message. Default: on. With it off, only the per-message wand button and the tool buttons run it. |
| `Max images per message` | Hard cap applied after validation, whatever the model returns. Default: 1. |
| `Use the appearance registry` | Send the per-chat appearance registry to the prompter. Default: on. See [Appearance Registry](#appearance-registry). |
| `Seed the registry automatically` | Spend one extra LLM call the first time the prompter runs in a chat, reading the character cards and every bound lorebook. Default: on. |
| `Debug logging` | Log the whole prompter round trip to the browser console: the assembled prompt in full and its per-section sizes, the request shape, the raw reply, and the validated directive with any corrections applied to it. Also turns the skip decision into a toast, so you can see the prompter deciding not to draw. Default: off. |
| `History messages` | How many messages before the target message the prompter sees. Default: 12. |
| `Include character card` / `user persona` / `author's note` / `running summary` | Which context sections to send. Card, persona and summary default to on; author's note defaults to off. |
| `World Info` | `Activated entries only` (default) or `Off`. Entries are read in dry-run mode, so the main chat's sticky, cooldown and recursion state is never touched. |
| `Max chars` | Character cap on the World Info section. Default: 4000. |
| `Prompter Instructions` | The prompter's system prompt, with a **Restore default** button. Your edits are never overwritten on update. |

### Prompt Control

| Setting | Description |
|---|---|
| `Prepend Prompt` | Custom tags added to the **start** of every positive prompt, before shot tags and the LLM's output. |
| `Negative Prompt` | Negative prompt applied to every generation. |
| `Append Prompt` | Custom tags added to the **end** of every positive prompt, after the LLM's output. |

### Sampler Settings

| Setting | Description |
|---|---|
| `Steps` | Number of sampling steps. |
| `CFG` | Classifier-Free Guidance scale. |
| `Sampler` | Sampler name (must be valid in your ComfyUI version). |
| `Scheduler` | Scheduler name (must be valid in your ComfyUI version). |
| `Denoise` | Denoise strength (1.0 for full generation). |

### Resolution & Locks

| Setting | Description |
|---|---|
| `Resolutions` | Width/height per AR token. Adjust for your model (SDXL needs higher values). |
| `Lock Resolution` | When enabled, ignores the LLM's AR token and uses a single fixed resolution for all generations. |
| `Lock Shot` | When enabled, ignores the LLM's SHOT token and uses a fixed shot type for all generations. |
| `Lock Seed` | When enabled, ignores the LLM's SEED token. Modes: `RANDOM` (always new), `LOCK` (reuse last message's seed), or `CUSTOM` (specific number). |

### Shot Tags

| Setting | Description |
|---|---|
| `Shot Tags` | Danbooru tags prepended to the prompt for each SHOT token. Fully customizable. |

### Polling & Timeouts

| Setting | Description |
|---|---|
| `Max Poll Attempts` | How many times ComfyUI is polled, one second apart, before an image is given up on. Default: 180 (about 3 minutes of generation time). |
| `Request Timeout (ms)` | How long a single network request may hang before it is abandoned. Default: 30000. Image downloads and uploads always get at least 60 seconds, since they move real bytes. |

These two are not the same bound. Poll Attempts counts polls; the timeout bounds the time any one request may spend waiting. Without it a single dead socket would block every image queued behind it, because ComfyUI submissions are deliberately serialized. Five failed polls in a row are reported as "ComfyUI stopped responding" rather than waiting out the full attempt budget, so a ComfyUI that has gone away is not mistaken for a slow one — a single failed poll is still tolerated and retried.

### Notifications

| Setting | Description |
|---|---|
| `Marker Repair Notifications` | Controls toast notifications. `All repairs` shows successful repaired markers as well as failures. `Parse failures only` (default) shows failures only. `Off` disables automatic toasts entirely. |

Despite the name, this is ComfyInject's only notification preference, so every automatic failure notice honours it: a failed generation, an image that could not be saved locally, a prompter request that timed out or came back unparseable. Anything you click — Retry, the per-message wand, the tool buttons in settings — always answers, whatever the setting says. Silence in response to a button press would be a bug, not a preference.

ComfyInject still repairs many malformed markers automatically even when toast notifications are disabled. Full repair details remain visible in the Image Gallery, and failures are always logged to the browser console.

> **Note for SDXL users:** Default resolutions are SD1.5 sized (512px). Bump them up — e.g. PORTRAIT to 832x1216.

To reset all advanced settings back to defaults while keeping your host, checkpoint, and workflow, press the **Reset Advanced to Defaults** button at the bottom of the Advanced Settings panel.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Marker Format

> Applies to **Marker** and **Both** mode. In **Dedicated** mode markers are not a trigger at all — see [Dedicated Prompter](#dedicated-prompter).

The recommended marker format is:

```
[[IMG: PROMPT | AR | SHOT | SEED ]]
```

Multiple markers per message are supported — each one generates a separate image.

ComfyInject uses a lenient parser:
- Missing AR, SHOT, or SEED fields are auto-filled with built-in parser defaults.
- AR, SHOT, and SEED can be out of order and are detected by token type.
- Duplicate AR, SHOT, or SEED fields keep the first value and ignore later duplicates.
- Large standalone numbers left inside prompt text are preserved and flagged in repair metadata as a possible seed-in-prompt warning.
- The main parser hard-fails are markers that resolve to an empty prompt or an empty marker body.

### Segments

**PROMPT** — Danbooru-style comma-separated tags describing only what a camera would see. Recommended tag order:
1. Subject (`1girl`, `1boy`, etc.)
2. Features (hair color, eye color, clothing, expression, body)
3. Environment (location, lighting, weather)
4. Modifiers (style, additional visible details)

**AR** — Aspect ratio. Must be one of:

| Token | Resolution (default) |
|---|---|
| `PORTRAIT` | 512 x 768 |
| `SQUARE` | 512 x 512 |
| `LANDSCAPE` | 768 x 512 |
| `CINEMA` | 768 x 432 |

**SHOT** — Camera shot type. Each token prepends Danbooru tags to the positive prompt automatically:

| Token | Tags injected (default) |
|---|---|
| `CLOSE` | `close-up, face focus` |
| `MEDIUM` | `upper body` |
| `WIDE` | `full body` |
| `DUTCH` | `dutch angle` |
| `OVERHEAD` | `from above, bird's eye view` |
| `LOWANGLE` | `from below` |
| `HIGHANGLE` | `from above` |
| `PROFILE` | `profile, from side` |
| `BACKVIEW` | `from behind` |
| `POV` | `pov` |

To change these tags, open the Extensions panel → ComfyInject → **Advanced Settings** → **Shot Tags**.

**SEED** — Seed control:

| Value | Behaviour |
|---|---|
| `RANDOM` | Generate a new random seed |
| `LOCK` | Reuse the seed from the last saved message (stable across swipes) |
| integer | Use a specific seed |

### Example

```
[[IMG: 1girl, long red hair, green eyes, white sundress, standing in heavy rain, wet cobblestone street, neon lights reflecting in puddles, cinematic lighting | PORTRAIT | MEDIUM | RANDOM ]]
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## System Prompt

> **Marker mode only.** This whole section — the instruction block below included — exists to teach your roleplay model the marker format. In **Dedicated** mode nothing here applies: the prompter is a separate call with its own instructions, and the roleplay model is never asked for a marker. If you switch to Dedicated mode, **delete this block from your Post-History Instructions.** It is a permanent instruction riding along on every single request to your main model, so removing it is both a token saving and a prose-quality win.
>
> In **Both** mode, keep it.

Add the following to your **Post-History Instructions** (You can also place it in **Author's Note**, **Prompt Content**, or even in your **Summary** if that's what you want!). Placing it there puts it closer to the end of the context window, which gives significantly better format compliance than a top-level system prompt.

The example below tells the LLM to include one image per message. You can change the number to whatever you want, or tell it to include images "when narratively appropriate" for more flexibility.

This prompt teaches the LLM the canonical format. ComfyInject can repair many malformed markers, but better compliance still gives more predictable results.

```
IMAGE INJECTION RULES
You MUST include exactly one image marker in EVERY response without exception.
A response without an image marker is an error. Do not skip it for any reason.

The marker must follow this exact format:
[[IMG: PROMPT | AR | SHOT | SEED ]]

Exactly four segments separated by the pipe character |. No additional brackets. No extra segments. Place the marker at the most narratively appropriate point in your response.

PROMPT:
A comma-delimited list of Danbooru tags describing only what a camera would see.
Construct tags in this exact order:
1. Subject (1girl, 2girls, 1boy, etc.)
2. Features (hair color, eye color, clothing, expression, body) — use ONLY details explicitly stated in the character card, memory, or previous image markers. Do not invent or assume any visual details.
3. Environment/Background (location, lighting, weather)
4. Modifiers (style, additional visible details)

If the scene is dramatic, prepend the entire prompt with "dramatic," before the subject.
No emotional adjectives. No abstract themes. No metaphor. Only visible, concrete tags.
If characters are physically interacting, specify exactly which body parts are interacting and how.

AR must be exactly one of:
PORTRAIT, SQUARE, LANDSCAPE, CINEMA

SHOT must be exactly one of:
CLOSE, MEDIUM, WIDE, DUTCH, OVERHEAD, LOWANGLE, HIGHANGLE, PROFILE, BACKVIEW, POV

SEED must be exactly one of:
LOCK, RANDOM, or a numeric integer.
Use RANDOM for the first image of a new character or scene.
Use LOCK to maintain the appearance of the previous image.
Use a numeric integer to match a specific previous generation.

Maintain scene consistency: reference previous image markers for character appearance before referencing the character card. Do not change established visual details unless the story explicitly changes them.

Full example of a correct marker:
[[IMG: 1girl, long red hair, green eyes, white sundress, standing in heavy rain, wet cobblestone street, neon lights reflecting in puddles, cinematic lighting | PORTRAIT | MEDIUM | RANDOM ]]

If any segment is invalid or missing, regenerate the entire marker before continuing.
Never explain or mention the marker in narration.
```

> **Model recommendations:** Larger models (70B+) or cloud APIs like DeepSeek V3.2 follow the format far more reliably than small local models. Models under 13B tend to produce inconsistent markers and hallucinate character details. However, with update v0.3.0, many of the previously rejected markers from smaller models will now parse correctly and produce an image regardless. 

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Dedicated Prompter

Marker mode asks your roleplay model to do four jobs at once on top of writing prose: decide *whether* a moment deserves an image, decide the framing, translate narrative into booru tags, and keep a character's appearance consistent across images. The third job actively fights the first: a model that has just been told to write keyword lists tends to bleed keyword-listing style back into its prose.

Dedicated mode moves all four jobs to a second LLM call. That call reads the chat, returns a validated JSON object, and never writes prose. Your roleplay model goes back to only writing prose, and the marker instruction block comes out of your Post-History Instructions entirely.

The prompter returns exactly this:

| Field | Meaning |
|---|---|
| `generate` | Whether this message is worth illustrating at all. |
| `reason` | One short clause explaining the decision. Visible in debug logging and in Test Prompter — this is what you read when the prompter's judgement looks wrong. |
| `images[].prompt` | Booru-style comma-separated tags. |
| `images[].ar` | One of `PORTRAIT`, `SQUARE`, `LANDSCAPE`, `CINEMA`. |
| `images[].shot` | One of `CLOSE`, `MEDIUM`, `WIDE`, `DUTCH`, `OVERHEAD`, `LOWANGLE`, `HIGHANGLE`, `PROFILE`, `BACKVIEW`, `POV`. |
| `images[].characters` | Who the prompter believed it was drawing. Used to grow the [Appearance Registry](#appearance-registry); never sent to ComfyUI. |

There is no seed field. Seeds stay the extension's business, so **Lock Seed** keeps working exactly as it does in marker mode.

`generate: false` is a normal, quiet outcome — no image, no error, no toast. Turn on **Debug logging** if you want to see the reason for every skip.

Everything downstream of the prompt is the shared path: the same `<img>` tag, the same retry button, the same gallery, the same local saving, the same cleanup on chat deletion. Generated images are appended at the end of the message.

### Turning it on

1. Open **Dedicated Prompter** in the extension settings.
2. Set **Trigger Mode** to *Dedicated*.
3. Pick a **Connection Profile**. Only Chat Completion and Text Completion profiles can be selected — those are the only two SillyTavern's Connection Manager supports. With nothing selected, ComfyInject falls back to your currently active main API.
4. Delete the marker instruction block from your Post-History Instructions.

ComfyInject never stores a credential. It stores a profile id; the model, endpoint and API key stay in SillyTavern's own Connection Profile.

**Structured output.** With **Native** selected, the schema is handed to SillyTavern, which translates it per backend — a `response_format` on OpenAI-style sources, a tool call on Claude, a response schema on Google. If the backend refuses it, ComfyInject retries the same request in prompt-engineered mode and remembers the refusal, so it does not spend a rejected request every message from then on. Text Completion profiles have no server-side equivalent and go straight to prompt-engineered mode.

Structured output also survives the no-profile case: SillyTavern's raw generation path accepts a schema too, so falling back to your main API does not cost you schema enforcement. What it does cost is abort — that path cannot be cancelled mid-request, so no Stop control is offered on it.

A reply that fails to parse is a **skip**, not a repair target. The marker path's salvage cascade exists because a prose model writes malformed markers; there is nothing to salvage here, and pretending otherwise would re-add the exact failure surface this mode removes.

### What the prompter sees

One system message, assembled in this order:

1. **TASK** — your **Prompter Instructions**.
2. **APPEARANCE REGISTRY** — the per-chat appearance cache.
3. **SESSION** — chat id, character or group name, persona name.
4. **CHARACTER CARD** — description, personality, scenario and depth prompt, macro-resolved, with chat-level overrides honoured. First messages and example dialogue are deliberately left out: they cost tokens and teach prose style the prompter must not imitate.
5. **USER PERSONA**
6. **AUTHOR NOTE** — off by default.
7. **RUNNING SUMMARY** — whatever the Summarize extension last wrote. This is what keeps a long chat legible past the history window.
8. **WORLD INFO**
9. **RECENT HISTORY** — the last N messages, with the scope stated in the section header so the model knows what it is missing.
10. **TARGET MESSAGE** — the message being illustrated.
11. **OUTPUT RULES** — the schema and the hard constraints, last.

Two things worth knowing about how that context is read:

- **World Info is read in dry-run mode.** Sticky, cooldown and recursion state in your main chat is never touched, and no `WORLD_INFO_ACTIVATED` event is emitted. The prompter can see your lorebook without disturbing the roleplay's own lore rotation.
- **ComfyInject's own output is stripped out.** Every `<img>` tag and every `[[IMG: ...]]` marker is removed from the history and from the target message before the prompter sees them, so the prompter never learns to imitate its own past output.

### Appearance Registry

The hardest of the four jobs is consistency: keeping the same character's hair, eyes and outfit stable across images generated an hour apart. Marker mode cannot really do this — the model only ever sees its own previous prompt text echoed back.

Dedicated mode keeps a small per-chat registry, stored in chat metadata:

| Source badge | Where the entry came from |
|---|---|
| `seed` | The seeding pass: one extra LLM call, the first time the prompter runs in a chat, which reads the character cards and every bound lorebook (character, group members, chat, persona, and your globally selected books) and extracts stable appearance tags per character. Bound books are read in full, not scanned for activation — an appearance entry that is not currently triggering still describes the character. |
| `grown` | Distilled from a generated image's own prompt. This is the brand-new-NPC case: someone introduced two messages ago has no card and no lorebook entry, but by their second image they have a stable entry. Growth only fires on single-character images — with two characters in one prompt there is no way to tell whose hair is whose. Camera, pose, expression, setting, lighting and quality tags are filtered out, so `rain, night, city street` never freezes into who someone *is*. |
| `user` | You edited it by hand. **`user` entries are never overwritten by seeding or growth.** A bad automatic entry is fixable by hand instead of by re-rolling the model. |

The registry is per-chat, not global: the same character can legitimately look different in a different chat after an outfit change, a timeskip, or an AU. It is capped at 40 entries and 400 characters each, because it is injected into every request.

`grown` entries are a heuristic and are labelled as one — that is exactly why the source badge exists. If one is wrong, fix it in the registry editor and it becomes a `user` entry that nothing will touch again.

**Overlap with Prepend Prompt.** [Prompt Control](#prompt-control)'s **Prepend Prompt** is added to *every* prompt unconditionally. The registry is per-character and selected by the prompter. They compose, so don't put the same appearance tags in both.

### The three tool buttons

At the bottom of the Dedicated Prompter panel:

- **Preview Context** — shows exactly what would be sent, section by section, with character counts, a total token count, and which transport would be used. Costs nothing and calls nothing. This is where to look first when the prompter's output is surprising: usually the answer is that a section you assumed was there is empty.
- **Test Prompter** — runs one real request against the current chat's last message and shows the raw reply, the validated result, and any validation notes. **No image is generated.**
- **Appearance Registry** — the editor. Per-row edit and delete, add by hand, seed on demand, clear all. Editing a row flips its badge to `user`.

Every bot message also gets a small wand button in its button row for running the prompter on that message by hand. That one is the only way to trigger anything when **Run automatically on new messages** is off.

### Both mode

Markers win. The marker path runs first, and the prompter stands down on any message that already got an image from it. A message with no marker falls through to the prompter, which is the useful case: a model that emits markers unreliably gets covered rather than replaced.

Keep the marker instruction block in your Post-History Instructions in this mode, and note that outgoing images are still rewritten as `[[IMG: prompt | seed ]]` so the marker format stays reinforced.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Image Gallery

ComfyInject includes a built-in image gallery accessible from the extension panel. Click the **Image Gallery** button to open it.

The gallery shows all generated images in the current chat as a grid of thumbnails. Each thumbnail displays the seed and message number. Click any image to expand it and see the full details:

- **Seed** — the numeric seed used for generation
- **Prompt** — the final prompt sent for generation after parsing salvages and token extraction
- **AR** — the aspect ratio token and actual resolution used
- **Shot** — the shot type token and actual tags injected
- **Filename** — the output filename in ComfyUI's output folder
- **Prompt ID** — the ComfyUI job ID, clickable as a link to the ComfyUI history endpoint for debugging

If an image marker was repaired during parsing, the thumbnail shows a warning badge. In the detail view, a Repair Info section shows:
- which fields were defaulted
- which duplicate AR / SHOT / SEED tokens were ignored
- whether a possible seed remained in the prompt

The gallery always reflects what's currently on screen — swiping to a different response updates the gallery accordingly.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Retry Button

Every generated image has a small retry button (rotate icon) in the top-right corner. Clicking it regenerates that specific image with a new random seed while keeping the same prompt, aspect ratio, and shot type. The retry button always bypasses the seed lock setting to guarantee a different result.

During regeneration, the button shows a spinning icon. The new image replaces the old one in the chat and is saved permanently.

In messages with multiple images, each retry button only affects its own image — the others are left untouched.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Local Image Saving

By default, ComfyInject does not leave your chat pointing at ComfyUI. As soon as an image is generated it is downloaded, shrunk, and copied into SillyTavern's own image storage under `data/<user>/user/images/<character>/`, and the message links to that copy.

This matters for two reasons:

- **Chats load without ComfyUI.** A hotlinked image only renders while the ComfyUI machine is awake and reachable. A saved copy is served by SillyTavern itself.
- **Chats get dramatically lighter.** A full-size 1.8 MB PNG typically becomes well under 100 KB as WebP, which is the difference between a usable and an unusable chat on a phone.

Saving never costs you an image. If the download, the conversion, or the upload fails, ComfyInject keeps the original ComfyUI URL and warns you instead of losing the result. If only the downscale step fails, the full-size original is saved as-is.

Message images are also marked `loading="lazy"` and `decoding="async"`, so a long chat full of images no longer blocks rendering on pictures that are still off-screen.

### Cleanup when a chat is deleted

SillyTavern deletes only the chat file when you delete a chat, which would otherwise leave every image that chat generated on disk forever. With **Delete images when their chat is deleted** enabled, ComfyInject cleans up after itself.

Because SillyTavern stores images in one folder per *character* — shared by every chat with that character, alongside images from other sources — deletion is deliberately conservative:

- ComfyInject only ever considers images **it saved itself**. Anything else in the folder is left alone.
- Before deleting, every surviving chat for that character or group is read. An image still referenced by any of them is kept, and handed over to that chat so it stays eligible for cleanup later. This covers branched and duplicated chats, images sitting in a swipe you can still flip back to, and images referenced from continuation history.
- If any of those checks cannot be completed, nothing is deleted.

Chat renames are tracked, so renaming a chat does not orphan its images.

> **Only applies going forward.** Images generated before this feature existed were never recorded, so deleting those chats will not clean them up. You can remove them by hand from `data/<user>/user/images/<character>/`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Custom Workflows

The default workflow (`workflows/comfyinject_default.json`) uses only built-in ComfyUI nodes and works out of the box with any standard checkpoint.

To use your own workflow, see `workflows/README.md` for placeholder requirements. Once your workflow JSON is in the `workflows/` folder, type its filename into the **Workflow** field in the extension settings. The field validates automatically — you'll see a success or error notification after you stop typing.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## How It Works

Steps 1 and 2 depend on the trigger mode. Everything from step 3 on is shared.

**Marker mode:**

1. Bot message arrives containing one or more `[[IMG: ... ]]` markers
2. ComfyInject parses each marker, salvages misplaced control tokens when possible, applies built-in fallbacks for missing fields, and resolves seeds while applying any active locks

**Dedicated mode:**

1. Bot message arrives. On the first message of a chat the appearance registry is seeded from the character cards and every bound lorebook
2. One LLM call is assembled from the context sections and sent to the prompter's Connection Profile. The reply is parsed, validated and clamped; `generate: false` stops here. Any character the reply names who is not in the registry yet is added to it

**Both modes, from here on:**

3. For each image, the workflow is filled with your settings and submitted to ComfyUI through a single serial queue, so two messages arriving quickly cannot collide
4. ComfyInject polls `/history` until each image is ready
5. The finished image is downloaded from ComfyUI, downscaled to WebP, and uploaded into SillyTavern's own image storage, so the message can point at a local copy instead of hotlinking ComfyUI. On any failure it falls back to the ComfyUI URL
6. The image becomes an `<img>` tag in the chat permanently — replacing the marker in marker mode, appended at the end of the message in dedicated mode
7. Image metadata (AR, shot, prompt ID, filename, effective settings, and either repair metadata or the prompter's reason and character list) is saved to chat metadata keyed by message timestamp for stability across deletions
8. The saved image is recorded against the current chat so it can be cleaned up if that chat is ever deleted
9. On the next generation, the outbound interceptor replaces `<img>` tags with a compact text reference instead of raw HTML — `[[IMG: prompt | seed ]]` in marker and both mode, so the format stays reinforced, and a neutral `[image: prompt]` in dedicated mode, where teaching the main model marker syntax would be counterproductive. Quiet generations (summaries and other extensions' background calls) are left alone in every mode
10. Retry buttons are injected via DOM manipulation after each render

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Known Limitations

- With **Save generated images to SillyTavern** turned off, images link to your local ComfyUI `/view` endpoint instead. If ComfyUI is not running on reload, those images will not display (the `<img>` tag is saved but the file must be served by ComfyUI).
- The generating placeholder may not appear on some versions of SillyTavern. This is a cosmetic limitation with no impact on functionality.
- Deleted messages leave orphaned image files in ComfyUI's output folder. ComfyInject does not delete these files — manage your ComfyUI output folder as needed. Cleanup on chat deletion only covers the copies saved inside SillyTavern.
- Images generated before local saving existed were never recorded, so deleting those chats will not clean them up. See [Local Image Saving](#local-image-saving).
- **Dedicated mode** costs one extra LLM call per message it decides to illustrate, plus one more the first time it runs in a chat if registry seeding is on. Skipped messages still cost the deciding call.
- **Dedicated mode** appends its image at the end of the message rather than at the narratively right point inside it. Marker mode can place an image mid-message; the prompter cannot yet.
- Only Chat Completion and Text Completion Connection Profiles can be selected for the prompter — those are the only two SillyTavern's Connection Manager supports.
- The gallery's repair badge and Repair Info section are marker-mode concepts. Dedicated-path images never carry them, because there is nothing to repair.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## FAQ

### How do I find my checkpoint filename in ComfyUI?

The easiest way is to click the dropdown arrow next to the Checkpoint field in ComfyInject's settings — if ComfyUI is running, it will fetch and display all your available checkpoints for you to select from.

Alternatively, open your ComfyUI root folder and navigate to `ComfyUI/models/checkpoints`. The filenames of the models in that folder are exactly what you need to paste into ComfyInject's Checkpoint field, including the file extension (e.g. `waiIllustriousSDXL_v160.safetensors`).

You can also find it in ComfyUI itself — open ComfyUI, load any workflow, and find the Load Checkpoint node. Click the dropdown on that node and you'll see a list of all your available models. Note down whichever one you want and type it exactly into ComfyInject's Checkpoint field.

If the checkpoints folder is empty or the dropdown shows nothing, you'll need to download a model first. SD1.5 is a good beginner friendly starting point. You can find models on Hugging Face or Civitai. Once downloaded, drop the model file into the `ComfyUI/models/checkpoints` folder and restart ComfyUI. After that, the model should appear in both ComfyUI and ComfyInject's dropdown.

---

### Where are the generated images stored?

In two places. ComfyUI writes its own full-size output to its `output/` folder as always — ComfyInject never touches that. Separately, a downscaled WebP copy is saved inside SillyTavern at `data/<user>/user/images/<character>/`, and that copy is what your chat actually displays.

That means you can clear ComfyUI's `output/` folder without breaking your chats. Deleting a chat removes the copies saved inside SillyTavern for it, but never anything in ComfyUI's output folder. See [Local Image Saving](#local-image-saving).

---

### How is this different from ST's built in image generation?

ST's built in image generation builds the prompt itself from the chat context — the LLM has no awareness of the image at all. It also requires a Chat Completion API with function calling enabled, so text completion users can't use it.

In **marker mode** the roleplay LLM writes the image prompt directly into its response, controls the framing and seed, and can reference its own previous images for visual continuity via the outbound interceptor. It works with any backend and any LLM that can follow structured output instructions.

In **dedicated mode** the prompt is written by a second LLM call, which is closer to what ST's built-in does — but with three differences that matter: the prompt goes through your ComfyUI workflow rather than ST's own image pipeline, the decision of *whether* to illustrate is made by a model reading the scene rather than by you pressing a button, and the [Appearance Registry](#appearance-registry) pins each character's appearance across the whole chat instead of re-deriving it every time. Function calling is not required, and text completion backends work.

---

### Which trigger mode should I use?

**Dedicated**, if your main model is small, if its marker compliance is unreliable, if you dislike what marker instructions do to its prose, or if character appearance drifts between images. It costs an extra LLM call per illustrated message and buys back a shorter main prompt.

**Marker**, if your main model follows the format well, you want images placed mid-message rather than at the end, or you would rather not spend a second call.

**Both** is the hedge: markers when the model emits them, the prompter when it doesn't.

---

### Can I use my own custom workflow?

Yes! Export your workflow from ComfyUI using Save (API format), replace the relevant values with ComfyInject's placeholder strings, and save it to the `workflows/` folder. Then type the filename into the Workflow field in the extension settings. See `workflows/README.md` for the full list of placeholders and instructions. ComfyInject only touches the nodes where you place its placeholders — everything else in your workflow stays exactly as you have it.

---

### Does it work with text completion backends?

Yes! The marker approach works with any LLM that can follow structured output instructions regardless of backend. The outbound interceptor replaces injected images with a compact text token containing the original prompt and seed, so even non vision models can reference previous images for continuity.

---

### Can I have multiple images per message?

Yes! The LLM can include as many `[[IMG: ... ]]` markers as you want in a single message. Each marker generates a separate image sequentially. Adjust your system prompt to tell the LLM how many images to include per message.

---

### What do the lock settings do?

The lock settings let you override specific parameters regardless of what the LLM outputs:

- **Lock Resolution** — forces a single fixed resolution for all generations, ignoring the LLM's AR token.
- **Lock Shot** — forces a single shot type for all generations, ignoring the LLM's SHOT token.
- **Lock Seed** — forces a seed mode (RANDOM, LOCK, or a specific number) for all generations, ignoring the LLM's SEED token.

The LLM still outputs its tokens normally — the locks just override them at generation time. The gallery shows what was actually sent to ComfyUI so you can verify.

---

### Why isn't my image generating?

A few things to check:
- Make sure ComfyUI is running and `--enable-cors-header` is enabled
- Make sure the Checkpoint field in ComfyInject's settings matches your model filename exactly, including the file extension
- Make sure the Workflow field points to a valid workflow JSON in the `workflows/` folder
- Check the browser console for any error messages from ComfyInject
- If the marker resolves to an empty prompt or empty marker body, ComfyInject will replace it inline with a parse error instead of generating an image
- For successful repaired markers, check the Image Gallery for repair details
- For failed markers, check the browser console for parse or generation failure details, including the original failed marker when available
- Make sure your LLM is outputting the marker in the correct format — see the [Marker Format](#marker-format) section

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## License

AGPLv3 — see [LICENSE](LICENSE) for details.

---

*Built with VSCode and an embarrassing amount of help from [Claude](https://claude.ai) by Anthropic.*
