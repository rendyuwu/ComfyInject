# Custom Workflows

Place your ComfyUI workflow JSON files here.

ComfyInject ships with `comfyinject_default.json` which works out of the box using only built-in ComfyUI nodes. You only need a custom workflow if you want to use custom nodes, ControlNet, LoRAs wired in at the node level, or any other advanced setup.

---

## Placeholder Requirements

Your workflow JSON can use any of the following placeholder strings. ComfyInject will replace them with real values before sending to ComfyUI. **You don't have to use all of them** — only place the ones that are relevant to your workflow. Any placeholder not present in your JSON is simply ignored.

| Placeholder | Type | Description |
|---|---|---|
| `"{{CHECKPOINT}}"` | string | Model filename from the Checkpoint field in settings |
| `"{{POSITIVE_PROMPT}}"` | string | Prepend prompt + shot tags + LLM prompt + append prompt |
| `"{{NEGATIVE_PROMPT}}"` | string | Negative prompt from settings |
| `"{{WIDTH}}"` | integer | Image width in pixels |
| `"{{HEIGHT}}"` | integer | Image height in pixels |
| `"{{SEED}}"` | integer | Resolved numeric seed |
| `"{{STEPS}}"` | integer | Sampling steps |
| `"{{CFG}}"` | float | CFG scale |
| `"{{SAMPLER}}"` | string | Sampler name |
| `"{{SCHEDULER}}"` | string | Scheduler name |
| `"{{DENOISE}}"` | float | Denoise strength |

> The quotes are part of the placeholder syntax. In your JSON file, the value field must be the placeholder string in quotes, e.g. `"seed": "{{SEED}}"`. ComfyInject replaces the entire quoted string including the quotes with the correct typed value.

### About `{{CHECKPOINT}}`

Despite the name, this placeholder isn't limited to checkpoint models. It gets replaced with whatever you type into the **Checkpoint** field in the extension settings. If your workflow uses a `UNETLoader`, `DiffusionModelLoader`, or any other node that loads a model by filename, you can use `"{{CHECKPOINT}}"` in that node's model field and type the correct filename into ComfyInject's Checkpoint setting. All ComfyInject does is a text replacement — it doesn't care what type of node receives the value.

### Reusing Placeholders

Each placeholder can appear in **multiple places** across your workflow. Every occurrence will be replaced with the same value. For example, if two nodes in your workflow both need `steps`, you can put `"{{STEPS}}"` in both and they'll both receive the same value from your settings. This works for any placeholder.

---

## Positive Prompt Order

The `{{POSITIVE_PROMPT}}` placeholder is filled with the following components in order, separated by commas:

1. **Prepend Prompt** — custom tags from the Prepend Prompt setting (if set)
2. **Shot Tags** — Danbooru tags for the active shot type (e.g. `close-up, face focus` for CLOSE)
3. **LLM Prompt** — the prompt the LLM wrote in the marker
4. **Append Prompt** — custom tags from the Append Prompt setting (if set)

If resolution or shot lock is active, the locked values are used regardless of what the LLM specified.

---

## Krea 2 Turbo

`krea2_turbo.json` is the API-format graph for Krea 2 Turbo: `UNETLoader` for the distilled
checkpoint, `CLIPLoader` with type `krea2` over the `qwen3vl_4b` text encoder, `qwen_image_vae`,
and a `LoraTagLoader` in the prompt path so `<lora:name:weight>` calls written into the prompt
are applied and stripped before the text encoder sees them. That node is a custom node — without
it installed, ComfyUI will report a missing node instead of rendering.

It expects the same placeholders as any other workflow here, and three settings the graph cannot
state for itself:

- **Steps `8`, CFG `1.0`.** Turbo is distilled for eight steps and runs guidance-free. In a
  stock `KSampler`, CFG `1.0` is how guidance-off is spelled; `0.0` produces unconditional
  output. The negative prompt is zeroed in the graph, so the Negative Prompt setting is unused.
- **Resolution 1024 and up.** Krea 2 was trained at 2048 and degrades below 1024: portrait
  `1024x1536`, square `1024x1024`, landscape `1536x1024`, cinema `1536x864`. Keep both sides
  divisible by 16.
- **Sampler / scheduler `euler` / `simple`.** The Krea 2 time shift (`mu` 1.15) is applied by
  ComfyUI's own model class, so no `ModelSampling` node is needed.

Prompts for this model are natural-language paragraphs, not tag lists, so the shot-tag fields
belong empty and the prose owns the framing. `dev/comfyinject-prompter-krea2-nsfw.txt` is a
matching prompter settings file.

---

## Using a Custom Workflow

1. Export your workflow from ComfyUI using **Save (API format)** — not the regular Save.
2. Replace the literal values in your exported JSON with the placeholder strings from the table above.
3. Save the file into this folder.
4. In the ComfyInject extension settings, type your workflow filename into the **Workflow** field. The field validates automatically — you'll see a notification confirming whether the file was found.