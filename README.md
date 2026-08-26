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
    <li>
      <a href="#retry-button">Retry Button</a>
      <ul>
        <li><a href="#retrying-an-image-that-never-generated">Retrying an image that never generated</a></li>
      </ul>
    </li>
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
| `Schema in Prompt` | `Always` (default) restates the ~1,900-character schema JSON in **OUTPUT RULES** on every request. `Auto` leaves it out while the backend is enforcing the schema itself, and rebuilds the request with it if the backend refuses mid-flight. The prose rules and the worked example are always sent. See [Tuning the prompter](#tuning-the-prompter). |
| `Max Tokens` | Response budget for the prompter call. Default: 1024. Reasoning models may need more — a reply that runs out of budget mid-thought produces no image. |
| `Timeout (ms)` | Hard timeout per prompter call. Default: 60000. |
| `Run automatically on new messages` | Fire the prompter on every character message. Default: on. With it off, only the per-message wand button and the tool buttons run it. |
| `Generate Policy` | `Always` (default) illustrates every character message: the prompter only decides *what* to draw. `Judge` lets it decide whether the moment deserves an image at all. User messages never produce an image either way. See [Generate policy](#generate-policy). |
| `Max images per message` | Hard cap applied after validation, whatever the model returns. Default: 1. |
| `Max tags` | Hard cap on comma-separated tags per image prompt, truncated at a comma so a tag is never cut in half. `0` (default) turns it off. Enforced after the reply comes back rather than asked for in the prompt. It bounds only what the prompter writes — **Prepend Prompt**, the shot tag and **Append Prompt** are added afterwards and are not counted. |
| `Banned tags` | Comma-separated tags the prompter may not write. Stated in **OUTPUT RULES** and removed from the reply either way, before **Max tags** counts. Whole tags only, matched with `_` treated as a space, so banning either of `hand_holding` and `hand holding` catches both while `spine` leaves `spine_tattoo` alone. Also applied to the appearance registry's seeding pass. Empty by default. Not the same tool as **Negative Prompt** — see [Banning tags](#banning-tags). |
| `Use the appearance registry` | Send the per-chat appearance registry to the prompter. Default: on. See [Appearance Registry](#appearance-registry). |
| `Seed the registry automatically` | Spend one extra LLM call the first time the prompter runs in a chat, reading the character cards, every bound lorebook and the chat itself. Default: on. |
| `Seeding reads` | How many of this chat's own messages the seeding pass sees on top of the cards and the lorebooks. Default: 20. This is what lets two chats on the same character card end up with *different* registries. `0` reads the cards only, which produces the same registry in every chat that character is ever in. |
| `Re-seed every` | Run the seeding pass again once the chat has grown by this many messages. Default: 30. The first pass fires on the first illustrated reply, when the chat has told it almost nothing; the interval is how the registry catches up with a story that has since introduced people and changed what they wear. `0` seeds once per chat and never again. Costs one LLM call per interval; hand-edited rows are never overwritten. |
| `Seeding reads the running summary` | Include the Summarize extension's running summary in the seeding pass. Default: on. In a long chat it is the only thing that reaches past **Seeding reads**. |
| `Registry Scope` | `All` (default) sends every registry entry. `Present` sends only the character card's own cast plus anyone named in the target message or the history window. See [Appearance Registry](#appearance-registry) for the cost. |
| `Debug logging` | Log the whole prompter round trip to the browser console: the assembled prompt in full and its per-section sizes, the request shape, the raw reply, and the validated directive with any corrections applied to it. Also turns the skip decision into a toast, so you can see the prompter deciding not to draw. Default: off. |
| `History messages` | How many messages before the target message the prompter sees. Default: 6. This is the largest changing part of every request, so it is the biggest single lever on cost. |
| `Anchor stride` | Hold the history window's start still for this many messages at a time instead of sliding it by one every turn, so the rendered history is append-only between jumps. `0` (default) slides. Only useful on a backend that caches prompt prefixes — see [Prompt caching](#prompt-caching). A stride close to `History messages` makes the window's length vary a lot; half of it or less is a reasonable choice. |
| `Previous images` | Quote this many previously generated image prompts back to the prompter as the **PREVIOUS IMAGES** section, so clothing state carries across images. `0` (default) is off, `1` is the useful value, `3` is the cap. Off by default because it can make a model repeat itself — see [Wardrobe and scene continuity](#wardrobe-and-scene-continuity). |
| `Rotate frame direction` | Draw one framing focus and one manner per image slot from the two pools below and state them as the **FRAME DIRECTION** section, so successive images of a scene that has not moved are framed differently by construction. Default: off, and inert until at least one pool is filled. See [Frame direction rotation](#frame-direction-rotation). |
| `Frame focus pool` | Comma-separated framing focus values to rotate through, e.g. `face, hands, silhouette`. Newlines separate too. Empty by default. |
| `Frame manner pool` | Comma-separated manner values paired with the focus, e.g. `candid, deliberate, off-centre`. Empty by default. Either pool may be left empty; the lines then carry only the other field. |
| `Include character card` / `user persona` / `author's note` / `running summary` | Which context sections to send. Card, persona and summary default to on; author's note defaults to off. |
| `World Info` | `Activated entries only` (default) or `Off`. Entries are read in dry-run mode, so the main chat's sticky, cooldown and recursion state is never touched. |
| `Max chars` | Character cap on the World Info section. Default: 4000. |
| `Prompter Instructions` | The prompter's system prompt, rendered as the **TASK** section, first. Role and framing. There is one shipped default per **Generate Policy**, and switching the policy carries an untouched field over to the matching text while leaving an edited one alone. Safe to rewrite wholesale: the output contract lives in **OUTPUT RULES**, not here. |
| `Constraints` | Free text rendered as the **CONSTRAINTS** section, immediately after **TASK**. Empty by default and left out entirely when empty. Standing facts about your *checkpoint* rather than your story, so you never have to edit the shipped instructions to state one. Lives in the unchanging half of the request, so a long block here is cached rather than re-sent every message. See [Constraints and Final Instructions](#constraints-and-final-instructions). |
| `Example Image Prompt` | The `prompt` string inside the worked example in **OUTPUT RULES**. See [Tuning the prompter](#tuning-the-prompter) — this is the field to change for a checkpoint that can only draw simple scenes. |
| `Final Instructions` | Free text rendered as the **last** section of the request, after the target message. Empty by default, and left out entirely when empty. |
| `User Turn` | The ask, appended at the end of the request's user message. |
| `Assistant Prefill` | Assistant prefill text. Only applies when no Connection Profile is selected, and only to requests that are not schema-constrained. The panel says which of those you are currently in. Empty by default. |
| `Seeding Instructions` | The appearance registry's seeding pass has its own job, so it has its own system prompt. |
| `Seeding Example Tags` | The example registry entry in the seeding pass's own **OUTPUT RULES**. |
| `Seeding Final Instructions` | The seeding pass's own **last** section, empty by default and left out entirely when empty. Deliberately separate from **Final Instructions**: see [Tuning the prompter](#tuning-the-prompter). |
| `Seeding User Turn` | The user message that asks the seeding pass for its reply. Emptying it falls back to the shipped default rather than to **User Turn**, which asks for something else entirely. |

Every prompt field whose shipped default is not empty has a **Restore default** button that restores only that field. The fields that default to empty — **Constraints**, **Banned tags**, **Frame focus pool**, **Frame manner pool**, **Final Instructions**, **Seeding Final Instructions**, **Assistant Prefill** — have none, because a button that clears a field you just filled is a footgun dressed as a convenience. Your edits are never overwritten on update, and they all survive **Reset Advanced Settings**.

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

No emotional adjectives. No abstract themes. No metaphor. Only visible, concrete tags.
If characters are physically interacting, tag the interaction itself (hug, hand_holding, back-to-back) rather than describing it in prose.

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
| `generate` | Whether this message is worth illustrating at all. Near-vestigial under **Generate Policy** `Always`, which is the default — see [Generate policy](#generate-policy). |
| `reason` | One short clause explaining the decision. Visible in debug logging and in Test Prompter — this is what you read when the prompter's judgement looks wrong. |
| `images[].prompt` | Booru-style comma-separated tags. |
| `images[].ar` | One of `PORTRAIT`, `SQUARE`, `LANDSCAPE`, `CINEMA`. |
| `images[].shot` | One of `CLOSE`, `MEDIUM`, `WIDE`, `DUTCH`, `OVERHEAD`, `LOWANGLE`, `HIGHANGLE`, `PROFILE`, `BACKVIEW`, `POV`. |
| `images[].characters` | Who the prompter believed it was drawing. Used to grow the [Appearance Registry](#appearance-registry); never sent to ComfyUI. |

There is no seed field. Seeds stay the extension's business, so **Lock Seed** keeps working exactly as it does in marker mode.

A skip is a normal, quiet outcome — no image, no error, no toast. Turn on **Debug logging** if you want to see the reason for every one. Under the default **Generate Policy** of `Always` a skip only happens when the reply carried no usable image at all.

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

Two messages. The split is on the static/volatile line, which is a cost decision as much as a stylistic one — see [Prompt caching](#prompt-caching).

**`messages[0]`, the system message.** Everything that does not change from one character message to the next:

1. **TASK** — your **Prompter Instructions**.
2. **CONSTRAINTS** — your **Constraints**. Omitted entirely when empty.
3. **APPEARANCE REGISTRY** — the per-chat appearance cache. Moves to the volatile message when **Registry Scope** is `Present`.
4. **SESSION** — chat id, character or group name, persona name.
5. **CHARACTER CARD** — description, personality, scenario and depth prompt, macro-resolved, with chat-level overrides honoured. First messages and example dialogue are deliberately left out: they cost tokens and teach prose style the prompter must not imitate.
6. **USER PERSONA**
7. **AUTHOR NOTE** — off by default.
8. **OUTPUT RULES** — the schema and the hard constraints, including the output contract and your **Banned tags**.

**`messages[1]`, the user message.** Everything that changes every turn:

9. **RUNNING SUMMARY** — whatever the Summarize extension last wrote. This is what keeps a long chat legible past the history window.
10. **WORLD INFO**
11. **RECENT HISTORY** — the last N messages, with the scope stated in the section header so the model knows what it is missing.
12. **PREVIOUS IMAGES** — what the last few pictures actually showed. Off by default; see [Wardrobe and scene continuity](#wardrobe-and-scene-continuity).
13. **TARGET MESSAGE** — the message being illustrated.
14. **FRAME DIRECTION** — one rolled focus and manner per image slot. Off by default and omitted entirely when off or when both pools are empty; see [Frame direction rotation](#frame-direction-rotation).
15. **FINAL INSTRUCTIONS** — your **Final Instructions**. Omitted entirely when empty.
16. **User Turn** — the ask, appended plainly at the end.

The ordering rule is unchanged: reference data first, standing orders last, and **Final Instructions** is still the last thing the model reads before the ask. **PREVIOUS IMAGES** is the one section placed deliberately *away* from the strongest position — see the subsection for why.

Five things worth knowing about how that context is read:

- **World Info is read in dry-run mode.** Sticky, cooldown and recursion state in your main chat is never touched, and no `WORLD_INFO_ACTIVATED` event is emitted. The prompter can see your lorebook without disturbing the roleplay's own lore rotation.
- **The rule about the registry travels with the registry.** "Use these tags verbatim" is the first line of the **APPEARANCE REGISTRY** section itself, not a line in **Prompter Instructions**, so it appears exactly when there are entries to obey and vanishes with them. A fresh chat, before its first seeding pass, is not told to consult a section that is not there.
- **ComfyInject's own output is stripped out.** Every `<img>` tag and every `[[IMG: ...]]` marker is removed from the history and from the target message before the prompter sees them, so the prompter never learns to imitate its own past output. **PREVIOUS IMAGES** is the one deliberate exception, and it quotes the tags rather than the markup for exactly that reason.
- **Macros are resolved in everything you typed.** `{{char}}`, `{{user}}` and the rest of SillyTavern's macro set expand in every prompter field, in **Prepend Prompt** and **Append Prompt**, in appearance registry tags, and in group member cards. See [Macros in prompter fields](#macros-in-prompter-fields).
- **Macros are *not* resolved a second time in the roleplay's own text.** World info, history and the target message arrive already resolved by SillyTavern, so braces a character wrote in dialogue survive verbatim.

### Generate policy

**Generate Policy** decides whether the prompter is a judge or only a director.

- **Always** (default) — every character message gets an image. The prompter is told so, and its `generate` boolean stops being able to veto a usable image. This is the illustrated-log reading: one picture per reply, as a visual record of the scene.
- **Judge** — the prompter decides whether the moment deserves an image and skips dialogue that shows nothing new. This is the behaviour that shipped first, kept verbatim.

Two things are true under both policies. User messages never produce an image — only the character-message event runs the prompter. And a reply with no usable image at all is still a skip: there is nothing to draw, and inventing something is worse than missing one.

Worth saying plainly before turning **Always** on with **Run automatically on new messages**: that is one ComfyUI submission per character message. The serial queue keeps them from colliding, but it does not make them fast, and near-duplicate consecutive images — the thing **Judge** avoids — become yours to want or not want.

Switching the policy also switches which text **Restore default** writes into **Prompter Instructions**. An untouched field is carried over for you; an edited one is left alone with a note, because silently rewriting a prompt you wrote is exactly the upgrade failure the **Restore default** buttons exist to prevent.

### Macros in prompter fields

`{{char}}`, `{{user}}`, `{{persona}}`, `{{time}}`, `{{random:a,b}}` — the full SillyTavern macro set — expand at request time in every field you can type into:

**Prompter Instructions**, **Constraints**, **Example Image Prompt**, **Final Instructions**, **User Turn**, **Seeding Instructions**, **Seeding Example Tags**, **Seeding Final Instructions**, **Seeding User Turn**, **Prepend Prompt**, **Append Prompt**, and appearance registry tags.

**Banned tags** is the one exception: it is a list of tags to match, not text to send, so it is compared literally.

Two footguns:

- **`{{char}}` in a group chat resolves to the active speaker**, which is SillyTavern's own behaviour and not what "the character" usually means in a whole-cast prompt. Check what it resolves to in **Preview Context** before relying on it.
- **Re-rolling macros re-roll every request.** `{{random:a,b}}`, `{{pick}}`, `{{roll}}` and `{{time}}` are a genuine feature for prompt variety and a genuine surprise if you expected a fixed instruction. One of them inside the system message also destroys the cached prefix on every request — see [Prompt caching](#prompt-caching).

Expansion happens at request time, not when you save the field, so an edited field is never frozen to whatever the macros meant when you typed it.

### Prompt caching

Only relevant on a backend that caches prompt prefixes — a Claude profile with SillyTavern's `claude.enableSystemPromptCache` on is the case this was designed against. Everyone else can skip this section; nothing here costs anything if you ignore it.

SillyTavern marks the **last block of the system prompt** as cacheable, and `cachingAtDepth` additionally marks the last non-assistant message. A cache write costs more than a plain input token (roughly 2× with `extendedTTL`, 1.25× without); a cache read costs about a tenth. So a system message that changes every request is worse than no caching at all — it pays the write premium and never gets the read back.

That is why the request is split the way it is. The system message holds only what stays the same between turns, so on the second character message in a chat it is a cache read rather than a write. What keeps it stable, and what breaks it:

| Keeps the prefix stable | Breaks it |
|---|---|
| `Registry Scope: All` | `Registry Scope: Present` — the registry then depends on the target message and moves to the volatile message |
| Fixed text in the prompter fields | `{{random}}`, `{{roll}}`, `{{time}}` in a system-message field |
| Long standing rules in **Constraints** | The same text in **Final Instructions**, which is charged in full every message |
| — | Discovering a new NPC, which rewrites the registry once and then settles |

**`History messages` is the biggest lever, not the caching.** The volatile message is charged at full price every turn whatever the layout does, and history is most of it. Lowering it from 12 to 6 saves more than anything else on this list; the default is 6 for that reason. **Anchor stride** is a second-order win on top: it holds the window's start still so the volatile text is append-only between jumps.

Turn on **Debug logging** to check any of this. It reports both block sizes and whether the system message was byte-identical to the previous request's in this chat.

### Tuning the prompter

Every case below is served by a field of its own, and none of them asks you to rewrite **Prompter Instructions**. That is deliberate. **Prompter Instructions** is role and framing; the output contract that has to hold whatever you write lives in **OUTPUT RULES**, where you cannot accidentally delete it. So the field is genuinely safe to rewrite — but an untouched one keeps receiving improvements on update, and an edited one cannot, so it is worth reaching for a narrower field first.

#### Your checkpoint can only draw simple scenes

A small SD1.5 or an anime-tag model falls apart past a handful of tags. Writing *"keep prompts short and simple"* into **Prompter Instructions** usually does nothing, because the worked example in **OUTPUT RULES** immediately below it shows thirteen tags — an example of a good reply outweighs a description of one. Change the example instead:

| Field | Value |
|---|---|
| `Example Image Prompt` | `1girl, solo, silver hair, standing, rain, night` |
| `Max tags` | `10` |

The example teaches the shape; **Max tags** enforces it whatever the model does with the hint. Asking politely is least reliable in exactly the case where it matters most, since a small model is also a poorly-instruction-following one — so the cap is applied to the reply rather than requested in the prompt. It truncates at a comma, so a tag is never cut in half, and a truncation is reported in the console whether or not debug logging is on.

#### Banning tags

**Banned tags** is the same argument taken one step further. A checkpoint that can only compose one figure does not need to be *asked* not to write `2girls`:

```
2girls, multiple_girls, 1boy, hug, couple, hand_holding, kiss,
leaning_on_person, head_on_chest, carrying, piggyback, sitting_on_lap
```

The list is stated in **OUTPUT RULES** and removed from the reply either way. Stating it is the cheap half — it is what covers a model that writes "two girls" as prose — and removing it is the half that actually works, because a model follows *"do not write X"* far less reliably than *"write Y"*.

Four details worth knowing:

- **Whole tags, not substrings.** `_` counts as a space, so banning either of `hand_holding` and `hand holding` catches both. Banning `spine` does **not** touch `spine_tattoo` — a substring ban is silent tag loss, which is also why wildcards and regex are not supported.
- **The ban runs before `Max tags` counts.** A banned tag never spends one of your cap slots.
- **It applies to the seeding pass too.** A banned tag that reached a registry entry would be injected into every later request, so it is never allowed into the registry in the first place.
- **The recital is capped at about 400 characters; enforcement is not.** A hundred banned tags cost you a `Set` lookup, not a hundred tags of prompt on every request.

Two things **Banned tags** is not:

- **Not the Negative Prompt.** [Negative Prompt](#prompt-control) is negative conditioning handed to the *image* model. This stops the *text* model writing the tag at all. For composition tags like `2girls` the negative prompt is the weaker tool, because SD negatives do not reliably suppress composition — the bodies still show up, slightly discouraged.
- **Not applied to Prepend Prompt or Append Prompt.** Those are added after the prompter is done, in `comfy.js`. A banned tag appearing in one of them is you contradicting yourself, not the model misbehaving — same caveat **Max tags** already carries.

#### Constraints and Final Instructions

Both are free text you own outright. They differ by **cost and position**, not by purpose:

| | Position | Cost | Use for |
|---|---|---|---|
| **Constraints** | Early — right after **Prompter Instructions** | In the unchanging half, so it is cached rather than re-sent | Long, static standing rules. Renderer facts, standing framing. |
| **Final Instructions** | Last — after the target message | In the changing half, charged in full every message | Short overrides that have to win. |

**Constraints** is where a fact about your *checkpoint* belongs: *"this checkpoint renders one figure only; a second body enters frame only as a POV"*, *"the camera is a third party, never the user's eyes"*, *"tag an outfit only after the narrative has changed it"*. These outlive your character cards, your chats and your policy switches, which is exactly why they should not be tangled into **Prompter Instructions**, and why they should not be paying the volatile half's price on every message.

**Final Instructions** stays the strongest slot, because position is what makes a rule win. If a rule is not being followed, move it there before rewording it.

Which means: a long standing preamble goes in **Constraints**, and the one line that has to beat everything else goes in **Final Instructions**. The section is titled `CONSTRAINTS` whatever you put in it — a section announcing itself as an override raises the refusal rate on a safety-trained model rather than lowering it.

One caveat, sharper here than anywhere else: a re-rolling macro like `{{random:a,b}}` in **Constraints** rewrites the cached prefix on every single request, which is precisely the cost the field exists to avoid. See [Prompt caching](#prompt-caching).

**Constraints** applies to the directive pass only. Renderer limits mean nothing to a pass whose whole job is extracting appearance tags.

#### Wardrobe and scene continuity

Have a character take her coat off, and two messages later she is drawn wearing it again. That is not the model being careless — it is the only thing it was given to trust about clothing.

There are three continuity channels, and until now only two of them were reachable by the prompter:

| Channel | What it owns |
|---|---|
| **APPEARANCE REGISTRY** | *Who a character is.* Hair, eyes, build, the outfit she normally wears. The seeding pass is explicitly told to refuse pose, expression, framing, lighting and weather, because those change from image to image and must not be pinned to a person. |
| **PREVIOUS IMAGES** | *What has happened to her.* Clothing state, accessories, injuries — the state the scene was left in. |
| **RECENT HISTORY** | *The events.* Whatever the prose happened to say, which overrides both of the above. |

The registry is right to refuse state: an outfit pinned to a character is exactly what puts a black coat back on someone who took it off two messages ago. But refusing it left state with nowhere to live, and the prompter is otherwise blind to its own previous output — the `<img>` strip above removes the one artifact that records what the last picture showed.

**Marker mode never had this problem.** The outbound rewrite has always fed saved image prompts back to the main roleplay model, so a marker-writing model could see what it drew last. Dedicated mode took that job off the main model and, until now, gave nothing to its replacement. So this is dedicated mode catching up, not new ground.

Set **Previous images** to `1` and add one line to **Constraints**:

| Field | Value |
|---|---|
| `Previous images` | `1` |
| `Constraints` | Read the recent history and PREVIOUS IMAGES for what she is wearing right now; when clothing has only partly changed, tag exactly what remains. |

The setting alone makes the feature available; that line is what makes it work as intended, and it belongs in your field rather than in a shipped default because only you know how much detail your setup wants.

**It defaults to `0`, and that is a real trade rather than a shipped bug.** Showing a model its last answer is the standard way to get the same answer again. The section is worded *"not a template to copy"*, it names the shot so the model has something to vary against, and it sits before the target message rather than after it — last is the strongest position, and here that would make copying *more* likely, not less. None of those is a guarantee. If three consecutive images stop varying their framing, drop to `1`, and if that is not enough go back to `0`.

Two smaller notes. The quoted prompts are filtered through **Banned tags** on the way in, because in `Both` mode a quoted prompt may have been written by the roleplay model and never validated at all — and a banned tag in text the prompter *reads* becomes one in text the prompter *writes*. And the shot label is omitted rather than guessed when it cannot be verified against the image it belongs to, since a wrong shot label is worse than none when the whole point is to vary away from it.

#### Frame direction rotation

The other half of the same problem. **PREVIOUS IMAGES** tells the prompter what the last frame showed and asks it to vary; **Rotate frame direction** stops asking and states the variation instead.

With it on, one **focus** and one **manner** are drawn from two pools you write and stated as the **FRAME DIRECTION** section, one line per image slot **Max images per message** allows:

```
--- FRAME DIRECTION ---
One line per image slot this request allows; "image 1" is the first entry in
"images". That slot's frame emphasises the named region and carries the named
manner; how it gets there is yours to choose. An absent field is unconstrained.
image 1 — focus: hands; manner: candid
--- END FRAME DIRECTION ---
```

Both pools ship empty and the feature does nothing until at least one is filled. The vocabulary that suits a checkpoint is yours to write, and a shipped list would be a shipped opinion about framing applied to every install. Fill one pool and leave the other blank and the lines carry one field; the section says so, so silence reads as "unconstrained" rather than as something the model should fill in.

**The draw is not random.** It is a hash of the target message's own timestamp, which matters for two reasons: the request is rebuilt mid-flight when a backend refuses schema-constrained output, and **Preview Context** promises byte-identical output to what will actually be sent. A fresh draw per build would quietly break both. Everything else follows from that — the same message always asks for the same frame, and re-rolling a message means asking a different message.

A value the previous turn gave the *same slot* is skipped where the pool has room, so two consecutive images do not open on the same instruction. That is what the rotation is; a pool of one value rotates nothing. The previous draw is remembered per chat and is spent only once an image has actually landed, so a ComfyUI failure or a chat you switched away from does not burn a value nothing was drawn from.

It composes with **Previous images** rather than replacing it: that section owns what the scene was left in, this one owns where the next frame looks.

#### The seeding pass is a separate call

It carries the same refusal risk and none of the directive pass's fields. It gets four slots of its own: **Seeding Instructions**, **Seeding Example Tags**, **Seeding Final Instructions** and **Seeding User Turn**.

They are deliberately not shared with the directive pass's, because the two ask different questions — generation policy is meaningless to a pass whose whole job is extracting stable appearance tags. The practical consequence: **whatever framing you write for one pass usually belongs in both.** The seeding call runs first, before the first image of a chat and again on every re-seed; if it is refused the registry stays empty, and an empty registry degrades every image after it. That failure is quiet — per-message prompts keep working, the pictures just stop agreeing with each other. If registry entries come back empty while the prompter is otherwise fine, that is the pass to look at.

**Banned tags** is the exception: one setting drives both passes, because a banned tag is a fact about the renderer and the renderer does not change between passes.

#### Your prompter model is small and local

Beyond the example and the tag cap, turn **Schema in Prompt** to `Auto`. The schema JSON is about 1,900 characters, and while the backend is enforcing the schema server-side those characters are pure noise competing with your instructions — worst on exactly the models that follow instructions least well. On `Auto` it is left out while native enforcement is active and the request is rebuilt with it if the backend refuses, so nothing is lost either way. The default is `Always` only because it is what shipped.

#### Assistant Prefill

The narrowest field here. `generateRaw` — the transport used when no Connection Profile is selected — accepts a prefill; `ConnectionManagerRequestService` has no prefill parameter, and a prefill contradicts native structured output anyway, since the backend is already constrained. The panel states whether yours would actually be sent rather than ignoring it quietly. **Constraints** and **Final Instructions** cover the standing-framing case on both transports; reach for a prefill only if they have not.

#### Prompt presets

Copy-paste starting points. Each one says what it assumes about your renderer; none of them touches **Prompter Instructions**.

**One-figure checkpoint** — an SD1.5 or anime checkpoint that cannot compose two bodies without producing a hybrid. This is the preset that should reach `1girl, solo` output on its own.

| Field | Value |
|---|---|
| `Banned tags` | `2girls, multiple_girls, 3girls, 1boy, 2boys, multiple_boys, hug, hugging, couple, hand_holding, kiss, leaning_on_person, head_on_chest, carrying, piggyback, sitting_on_lap, group` |
| `Constraints` | This checkpoint renders one figure only. Never tag a second body. When the scene involves another person, keep the frame on one character and imply the other through contact and framing only: a hand at the edge of frame, a shadow, `pov`, `solo focus`, `out of frame`. Prefer a close or medium shot when two people are physically together. |
| `Example Image Prompt` | `1girl, solo, long silver hair, red eyes, black coat, standing, rain, night, city street` |

**Danbooru, simple scenes** — a small local model that falls apart past roughly fifteen tags.

| Field | Value |
|---|---|
| `Example Image Prompt` | `1girl, solo, silver hair, black coat, standing, rain, night` |
| `Max tags` | `12` |
| `Schema in Prompt` | `Auto` |

**Natural-language checkpoint** — Flux, SD3 and friends want a sentence, not a tag list. This is the one preset that does need **Prompter Instructions**, because booru-tag style is stated there and there is nowhere else for prose style to live.

| Field | Value |
|---|---|
| `Example Image Prompt` | `A tall woman with long silver hair and red eyes stands alone on a neon-lit street at night, rain soaking her black coat.` |
| `Prompter Instructions` | Replace the *"Writing the prompt"* bullets with a plain-prose instruction: one or two descriptive sentences, subject first, then setting and lighting. Leave the rest of the field alone. |
| `Max tags` | `0` (a sentence has no tags to count) |

**A backend that refuses** — some backends decline a scene and return nothing at all. ComfyInject ships no text for this case: the fields below are where your own framing goes, in your own words, and whatever you write belongs in **both** passes — the seeding pass runs first, and a refusal there quietly degrades every image after it.

| Field | Value |
|---|---|
| `Constraints` | Your standing framing, stated once. Long text belongs here rather than in **Final Instructions**, because this half of the request is cached. |
| `Final Instructions` | The one line that has to win when a longer **Constraints** block is being ignored. |
| `Seeding Final Instructions` | The same line, for the seeding pass. |

**Wardrobe continuity** — clothing state that follows the story instead of reverting to the registry's outfit. Read [Wardrobe and scene continuity](#wardrobe-and-scene-continuity) before applying it: this is the one preset with a known downside.

| Field | Value |
|---|---|
| `Previous images` | `1` |
| `Constraints` | Read the recent history and PREVIOUS IMAGES for what she is wearing right now; when clothing has only partly changed, tag exactly what remains. |

These are a README section rather than a dropdown in the panel on purpose: a preset button that overwrites four textareas needs a confirmation step, an undo, and an answer for what happens when the shipped text changes under someone who applied it three months ago. A block you can read before you paste it costs nothing and leaves you in control of what lands in your fields.

**Preview Context** shows the result of any of these edits section by section, and costs nothing.

### Appearance Registry

The hardest of the four jobs is consistency: keeping the same character's hair, eyes and outfit stable across images generated an hour apart. Marker mode cannot really do this — the model only ever sees its own previous prompt text echoed back.

Dedicated mode keeps a small per-chat registry, stored in chat metadata:

| Source badge | Where the entry came from |
|---|---|
| `seed` | The seeding pass: one extra LLM call, the first time the prompter runs in a chat and every **Re-seed every** messages after that, which reads the character cards, every bound lorebook (character, group members, chat, persona, and your globally selected books) and the last **Seeding reads** messages of the chat itself, then extracts stable appearance tags per character. Bound books are read in full, not scanned for activation — an appearance entry that is not currently triggering still describes the character. |
| `grown` | Distilled from a generated image's own prompt. This is the brand-new-NPC case: someone introduced two messages ago has no card and no lorebook entry, but by their second image they have a stable entry. Growth only fires on single-character images — with two characters in one prompt there is no way to tell whose hair is whose. Camera, pose, expression, setting, lighting and quality tags are filtered out, so `rain, night, city street` never freezes into who someone *is*. |
| `user` | You edited it by hand. **`user` entries are never overwritten by seeding or growth.** A bad automatic entry is fixable by hand instead of by re-rolling the model. |

The registry is per-chat, not global: the same character can legitimately look different in a different chat after an outfit change, a timeskip, or an AU. It is capped at 40 entries and 400 characters each, because it is injected into every request.

**The storage being per-chat is not enough on its own**, which is worth stating because the symptom is confusing. A new chat starts with an empty registry — chat metadata is not carried over — but the automatic seeding pass fires on the very first character message, which in a fresh chat is the greeting. If that pass only ever read the character card and the lorebooks, it would write the same answer every time, and the registry would look like it had followed you from the old chat when in fact it had just been rebuilt from the same source. That is what **Seeding reads** and **Re-seed every** exist to fix: the pass reads the chat as well, prefers what the chat says over what the card says when the two disagree, is told not to add lorebook characters who have not appeared, and runs again as the story moves. To check which of the two you are looking at, open the registry editor — it says whether seeding has run in this chat and how many messages until the next pass.

**Registry Scope** decides how much of it goes out each time. `All` (default) sends every entry. `Present` sends only the character card's own cast — always, whether or not they are named — plus anyone whose name appears in the target message or the history window, matched on word boundaries so `Ana` does not ride along with `Anastasia`.

`Present` is for a long chat that has accumulated dozens of walk-on NPCs. The cost is real and is the reason it is not the default: someone referred to only as "the innkeeper" or by a pronoun is dropped, and their next image may contradict their last. It also moves the registry into the changing half of the request, so on a backend that caches prompt prefixes `All` is usually cheaper *as well as* better — see [Prompt caching](#prompt-caching).

`grown` entries are a heuristic and are labelled as one — that is exactly why the source badge exists. If one is wrong, fix it in the registry editor and it becomes a `user` entry that nothing will touch again.

**Overlap with Prepend Prompt.** [Prompt Control](#prompt-control)'s **Prepend Prompt** is added to *every* prompt unconditionally. The registry is per-character and selected by the prompter. They compose, so don't put the same appearance tags in both.

### The three tool buttons

At the bottom of the Dedicated Prompter panel:

- **Preview Context** — shows exactly what would be sent, split into the stable system message and the volatile user message, section by section, with character counts per block, a total token count, and which transport would be used. Costs nothing and calls nothing. This is where to look first when the prompter's output is surprising: usually the answer is that a section you assumed was there is empty.
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

### Retrying an image that never generated

A generation that fails — ComfyUI switched off, a checkpoint filename that does not exist, a workflow that errors — leaves a placeholder in the message instead of an image:

> `[Image generation failed]` **⟳ Retry**

The placeholder is saved text, so it survives a reload, and it carries the prompt, aspect ratio, shot and seed of the attempt that failed. Start ComfyUI, press **Retry**, and the placeholder becomes the image it was always meant to be. Hover the placeholder itself to see what the backend actually said.

Three things follow from the placeholder holding the prompt:

- **It costs no LLM call.** On the dedicated path the prompter has already written a directive for that message; retrying replays it rather than asking for a new one, which would come back different.
- **The seed is replayed, not re-rolled** — unlike the image retry button above. This is the first attempt at this image finally succeeding, not a second take on one that already exists.
- **The prompter stands down on a message that has one.** A failed placeholder counts as an image for the purpose of "this message has already been illustrated", so a swipe or a re-render will not quietly spend another call on it.

Placeholders are never sent to your roleplay model — [outbound rewriting](#how-it-works) strips them, the same way it rewrites real images into compact tokens. A marker that could not be *parsed* at all is a different case and still shows a plain `[Image marker invalid]`: there is no prompt in it to retry.

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

1. Bot message arrives. The character's **greeting is skipped** — it is card text the roleplay LLM never wrote, it is identical in every chat started on that card, and there is no story yet to illustrate. Automatic generation starts with the first reply after your first message. (The per-message button still illustrates a greeting if you want one.) On that first run, and again every **Re-seed every** messages, the appearance registry is seeded from the character cards, every bound lorebook and the chat so far
2. One LLM call is assembled from the context sections and sent to the prompter's Connection Profile. The reply is parsed, validated and clamped; `generate: false` stops here. Any character the reply names who is not in the registry yet is added to it

**Both modes, from here on:**

3. For each image, the workflow is filled with your settings and submitted to ComfyUI through a single serial queue, so two messages arriving quickly cannot collide
4. ComfyInject polls `/history` until each image is ready
5. The finished image is downloaded from ComfyUI, downscaled to WebP, and uploaded into SillyTavern's own image storage, so the message can point at a local copy instead of hotlinking ComfyUI. On any failure it falls back to the ComfyUI URL
6. The image becomes an `<img>` tag in the chat permanently — replacing the marker in marker mode, appended at the end of the message in dedicated mode
7. Image metadata (AR, shot, prompt ID, filename, effective settings, and either repair metadata or the prompter's reason and character list) is saved to chat metadata keyed by message timestamp for stability across deletions
8. The saved image is recorded against the current chat so it can be cleaned up if that chat is ever deleted
9. On the next generation, the outbound interceptor rewrites `<img>` tags out of the messages the roleplay LLM reads. In marker and both mode they become `[[IMG: prompt | seed ]]`, so the format stays reinforced and the seed carries forward. In dedicated mode they are **removed entirely**: the prompter reads the previous image's tags for itself, so the roleplay LLM has no reason to see a booru tag list in its own message history — and every reason not to, since it will start writing them. Failure placeholders are stripped in every mode. Quiet generations (summaries and other extensions' background calls) are left alone. This rewrite happens on a copy of the chat, so your saved messages, their images, the gallery and Retry are unaffected
10. Retry buttons are injected via DOM manipulation after each render, on finished images and on failure placeholders alike

If step 3, 4 or 5 fails, the image's slot in the message is filled with a `[Image generation failed]` placeholder carrying the prompt, framing and seed of the attempt, and its own Retry button re-enters the sequence at step 3 — see [Retrying an image that never generated](#retrying-an-image-that-never-generated).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Known Limitations

- With **Save generated images to SillyTavern** turned off, images link to your local ComfyUI `/view` endpoint instead. If ComfyUI is not running on reload, those images will not display (the `<img>` tag is saved but the file must be served by ComfyUI).
- The generating placeholder may not appear on some versions of SillyTavern. This is a cosmetic limitation with no impact on functionality.
- Deleted messages leave orphaned image files in ComfyUI's output folder. ComfyInject does not delete these files — manage your ComfyUI output folder as needed. Cleanup on chat deletion only covers the copies saved inside SillyTavern.
- Images generated before local saving existed were never recorded, so deleting those chats will not clean them up. See [Local Image Saving](#local-image-saving).
- **Dedicated mode** costs one extra LLM call per message it decides to illustrate, plus one more the first time it runs in a chat if registry seeding is on. Skipped messages still cost the deciding call.
- **Dedicated mode** appends its image at the end of the message rather than at the narratively right point inside it. Marker mode can place an image mid-message; the prompter cannot yet.
- **Dedicated mode** never illustrates the greeting automatically, and there is no setting to make it. Use the per-message button on the greeting if you want an image for it.
- **Dedicated mode** does not let the roleplay LLM see what was illustrated. Marker mode echoes each image's prompt back to it; dedicated mode removes the tag, on the grounds that a booru tag list in the model's own message history is something it starts imitating. If you want the roleplay LLM aware of the images, use **Both** mode.
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
- Nothing is lost while you work through the list. A generation that fails leaves a `[Image generation failed]` placeholder holding the prompt, so once the cause is fixed you press **Retry** on it rather than re-rolling the message — see [Retrying an image that never generated](#retrying-an-image-that-never-generated)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## License

AGPLv3 — see [LICENSE](LICENSE) for details.

---

*Built with VSCode and an embarrassing amount of help from [Claude](https://claude.ai) by Anthropic.*
