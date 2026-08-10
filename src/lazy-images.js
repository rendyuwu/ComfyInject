// DOMPurify hooks are global to the instance, and SillyTavern exposes its own
// instance as window.DOMPurify. Registering from here rather than patching
// public/scripts/chats.js keeps the upstream repo clean while still affecting
// every message SillyTavern renders.

/**
 * Defers loading of images inside chat messages.
 *
 * A chat full of generated images otherwise fetches and decodes all of them
 * on load, which blocks the first render. `afterSanitizeAttributes` runs once
 * DOMPurify has finished filtering attributes, so the attributes set here are
 * kept instead of being stripped again.
 */
export function initLazyImages() {
    const purifier = globalThis.DOMPurify;

    if (typeof purifier?.addHook !== "function") {
        console.warn("[ComfyInject] DOMPurify unavailable, message images will load eagerly");
        return;
    }

    purifier.addHook("afterSanitizeAttributes", (node, _data, config) => {
        // MESSAGE_SANITIZE marks the pass SillyTavern uses for chat messages.
        // Without this check the hook would also rewrite avatars and UI markup.
        if (!config?.MESSAGE_SANITIZE) return;

        if (node instanceof Element && node.tagName === "IMG") {
            node.setAttribute("loading", "lazy");
            node.setAttribute("decoding", "async");
        }
    });

    console.log("[ComfyInject] Lazy message images enabled");
}
