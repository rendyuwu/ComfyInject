// Shipped default text for every editable prompter string.
//
// These live in one file, apart from the settings table, because they are prose
// and the settings table is a table. Each one is referenced twice — once by
// `defaultSettings` and once by its **Restore default** button — and never
// inlined anywhere else: a second copy is a second thing to drift.
//
// `settings.js` re-exports all of them, so every other module keeps importing
// from `../../settings.js` exactly as it did before.
//
// Changing a string here changes the output of every install that has not edited
// that field. Treat an edit as a behaviour change, not a wording change.

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

// The `prompt` string inside the filled example in OUTPUT RULES. An in-context
// example of a filled reply outweighs prose instructions about what the reply
// should look like, which is why this is the single highest-leverage string in
// the whole assembled prompt: a model that can only draw simple scenes needs
// this shortened, not a paragraph asking it politely to keep things short.
export const DEFAULT_PROMPTER_EXAMPLE_PROMPT =
    "1girl, solo, long silver hair, red eyes, black coat, standing, rain, night, city street, neon lights, wet pavement";

// The user turn. The prompt itself is one big system message; chat-completion
// backends still want a user message to answer.
export const DEFAULT_PROMPTER_USER_TURN = "Return the JSON directive for the TARGET MESSAGE now.";

// The appearance registry seeding pass is a different job over the same
// transport, so it gets its own TASK body rather than sharing the directive
// pass's.
export const DEFAULT_PROMPTER_SEED_SYSTEM_PROMPT = `You extract stable physical appearance tags for the characters of a roleplay, so a text-to-image model can draw the same person the same way every time.

Rules:
- One entry per character in the CAST section. Use each character's name exactly as it appears there.
- Booru-style comma-separated tags only. No sentences, no narration.
- Include only what is stable and visible: apparent gender and age, hair colour, length and style, eye colour, skin tone, build, height, distinguishing marks, and the outfit the character normally wears.
- Do not include pose, expression, camera framing, lighting, setting, weather, mood or quality tags. Those change from image to image and must not be pinned to a character.
- Do not invent details the source text does not support. Five accurate tags are worth more than twenty guessed ones.
- Omit a character entirely if the source text says nothing about how they look.`;

// The example tag string in the seeding pass's OUTPUT RULES — the same leverage
// the directive example has, over the shape of a registry entry.
export const DEFAULT_PROMPTER_SEED_EXAMPLE_TAGS =
    "1girl, long silver hair, red eyes, pale skin, slender, black military coat, gold epaulettes";
