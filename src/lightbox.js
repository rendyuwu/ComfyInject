// Fullscreen image viewer: click a generated image in chat, or the full image
// in the gallery's detail view, to open it with zoom and pan.
//
// One delegated document click listener, because every image the extension
// renders is DOM-injected after the fact — a listener per image would have to be
// re-attached after every re-render, swipe and gallery rebuild.
//
// The geometry helpers (clampScale, anchoredTranslation, panLimit,
// clampTranslation) are pure and exported so a node script can exercise the zoom
// and boundary maths without a browser.

import { injectStyle, NARROW_QUERY } from "./prompter/overlay.js";

const VIEWER_ID = "comfyinject-lightbox";
const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.35;
const DOUBLE_TAP_SCALE = 2.5;
// Wide enough to catch a desktop double-click at the common 500ms OS threshold
// without pairing two independent taps.
const DOUBLE_TAP_MS = 500;
const TAP_SLOP_PX = 28;
const DRAG_SLOP_PX = 4;

/**
 * Clamps a scale factor into the viewer's supported range.
 * @param {number} scale
 * @returns {number}
 */
export function clampScale(scale) {
    if (!Number.isFinite(scale)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Translation that keeps the image point under `anchor` under it after a zoom.
 *
 * `anchor` and `translation` are both offsets from the viewport centre, so the
 * element's own position cancels out: a point at image-local coordinate u sits
 * at `translation + scale * u`, and holding it fixed across a scale change gives
 * `t' = a - (s'/s) * (a - t)`.
 *
 * @param {{x: number, y: number}} anchor - Zoom anchor, offset from viewport centre
 * @param {{x: number, y: number}} translation - Current translation
 * @param {number} fromScale
 * @param {number} toScale
 * @returns {{x: number, y: number}}
 */
export function anchoredTranslation(anchor, translation, fromScale, toScale) {
    const ratio = toScale / fromScale;
    return {
        x: anchor.x - ratio * (anchor.x - translation.x),
        y: anchor.y - ratio * (anchor.y - translation.y),
    };
}

/**
 * How far the image may be translated before an edge leaves the viewport.
 *
 * `size` is the image's fitted (scale 1) layout box. A dimension that is still
 * smaller than the viewport after scaling cannot move at all, so its limit is 0
 * and the image stays centred.
 *
 * @param {{width: number, height: number}} size
 * @param {{width: number, height: number}} viewport
 * @param {number} scale
 * @returns {{x: number, y: number}}
 */
export function panLimit(size, viewport, scale) {
    return {
        x: Math.max(0, (size.width * scale - viewport.width) / 2),
        y: Math.max(0, (size.height * scale - viewport.height) / 2),
    };
}

/**
 * @param {{x: number, y: number}} translation
 * @param {{x: number, y: number}} limit
 * @returns {{x: number, y: number}}
 */
export function clampTranslation(translation, limit) {
    return {
        x: Math.min(limit.x, Math.max(-limit.x, translation.x)),
        y: Math.min(limit.y, Math.max(-limit.y, translation.y)),
    };
}

const LIGHTBOX_CSS = `
/* The viewer is opened over the gallery (9999) and the prompter overlay (9999),
   so it sits above both. Viewport units, not percentages, for the same reason
   as those overlays: SillyTavern's <html> is a containing block for fixed
   children and measures 0px tall at mobile widths. */
#${VIEWER_ID} {
    position: fixed; top: 0; left: 0;
    width: 100vw; height: 100vh; height: 100dvh;
    z-index: 10000; background: rgba(0, 0, 0, 0.94);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; box-sizing: border-box;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
             env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    /* Mobile browsers must not steal the pinch for page zoom or the drag for
       scrolling while the viewer is open. */
    touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
#${VIEWER_ID} .comfyinject-lightbox-image {
    max-width: 100%; max-height: 100%; display: block;
    transform-origin: center center; will-change: transform;
    cursor: zoom-in; pointer-events: auto;
    -webkit-user-drag: none; user-select: none;
}
#${VIEWER_ID}.is-zoomed .comfyinject-lightbox-image { cursor: grab; }
#${VIEWER_ID}.is-panning .comfyinject-lightbox-image { cursor: grabbing; }
#${VIEWER_ID} .comfyinject-lightbox-toolbar {
    position: absolute;
    left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 6px;
    padding: 6px; border-radius: 999px;
    background: rgba(20, 20, 20, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
#${VIEWER_ID} .comfyinject-lightbox-button {
    min-width: 44px; min-height: 44px;
    display: flex; align-items: center; justify-content: center;
    padding: 0 12px; border: 0; border-radius: 999px;
    background: transparent; color: #fff;
    font-size: 16px; line-height: 1; cursor: pointer;
}
#${VIEWER_ID} .comfyinject-lightbox-button:hover { background: rgba(255, 255, 255, 0.16); }
#${VIEWER_ID} .comfyinject-lightbox-button:focus-visible {
    outline: 2px solid #6cb4ee; outline-offset: 2px;
}
/* Chat images look clickable, because they are. */
img.custom-comfyinject-image, img.comfyinject-image,
#comfyinject-gallery-detail img { cursor: zoom-in; }

@media ${NARROW_QUERY} {
    #${VIEWER_ID} .comfyinject-lightbox-toolbar {
        gap: 4px; padding: 5px;
        bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }
    #${VIEWER_ID} .comfyinject-lightbox-button {
        min-width: 42px; min-height: 42px; padding: 0 9px; font-size: 15px;
    }
}

/* Landscape phone: the bottom strip competes with the image's short side, so
   the controls move to the right edge and stack. */
@media (max-height: 500px) {
    #${VIEWER_ID} .comfyinject-lightbox-toolbar {
        top: 50%; bottom: auto; left: auto;
        right: calc(10px + env(safe-area-inset-right, 0px));
        transform: translateY(-50%);
        flex-direction: column;
    }
    #${VIEWER_ID} .comfyinject-lightbox-button { min-height: 40px; }
}
`;

// Teardown for the viewer currently on screen, or null when none is.
let teardown = null;

/**
 * Closes the fullscreen viewer if it is open.
 */
export function closeLightbox() {
    const fn = teardown;
    teardown = null;
    if (fn) fn();
}

/**
 * Opens `src` fullscreen. Replaces any viewer already open.
 * @param {string} src
 * @param {string} [alt]
 */
export function openLightbox(src, alt = "") {
    if (!src) return;
    closeLightbox();

    const overlay = document.createElement("div");
    overlay.id = VIEWER_ID;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt ? `Image viewer: ${alt}` : "Image viewer");

    const img = document.createElement("img");
    img.className = "comfyinject-lightbox-image";
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    overlay.appendChild(img);

    const toolbar = document.createElement("div");
    toolbar.className = "comfyinject-lightbox-toolbar";
    const buttons = [
        ["fa-plus", "Zoom in", () => zoomAtCentre(ZOOM_STEP)],
        ["fa-minus", "Zoom out", () => zoomAtCentre(1 / ZOOM_STEP)],
        ["fa-compress", "Reset zoom", () => resetView()],
        ["fa-xmark", "Close", () => closeLightbox()],
    ];
    for (const [icon, label, onClick] of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "comfyinject-lightbox-button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        button.addEventListener("click", onClick);
        toolbar.appendChild(button);
    }
    overlay.appendChild(toolbar);

    // `size` is the image's fitted layout box at scale 1, measured once it has
    // laid out. Translation is applied as a transform, so it never affects it.
    const state = { scale: 1, x: 0, y: 0, size: { width: 0, height: 0 } };
    const pointers = new Map();
    let pan = null;
    let pinch = null;
    let lastTap = null;
    let suppressClick = false;

    function apply() {
        img.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
        overlay.classList.toggle("is-zoomed", state.scale > 1);
    }

    function measure() {
        const rect = img.getBoundingClientRect();
        state.size = { width: rect.width / state.scale, height: rect.height / state.scale };
    }

    // The image is fitted to the content box, so the pan bounds and zoom anchors
    // must be measured against it too — with a notch, the padding is real space
    // the image is not allowed to occupy.
    let pad = { left: 0, top: 0, right: 0, bottom: 0 };

    function readPadding() {
        const style = getComputedStyle(overlay);
        pad = {
            left: parseFloat(style.paddingLeft) || 0,
            top: parseFloat(style.paddingTop) || 0,
            right: parseFloat(style.paddingRight) || 0,
            bottom: parseFloat(style.paddingBottom) || 0,
        };
    }

    function contentBox() {
        const rect = overlay.getBoundingClientRect();
        return {
            left: rect.left + pad.left,
            top: rect.top + pad.top,
            width: rect.width - pad.left - pad.right,
            height: rect.height - pad.top - pad.bottom,
        };
    }

    function viewport() {
        return { width: overlay.clientWidth - pad.left - pad.right, height: overlay.clientHeight - pad.top - pad.bottom };
    }

    function clampIntoView() {
        const limit = panLimit(state.size, viewport(), state.scale);
        const clamped = clampTranslation(state, limit);
        state.x = clamped.x;
        state.y = clamped.y;
    }

    function resetView() {
        state.scale = 1;
        state.x = 0;
        state.y = 0;
        pan = null;
        pinch = null;
        overlay.classList.remove("is-panning");
        apply();
    }

    /**
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} factor - Relative zoom, used when `absoluteScale` is null
     * @param {number} [absoluteScale]
     */
    function zoomAt(clientX, clientY, factor, absoluteScale = null) {
        const box = contentBox();
        const anchor = {
            x: clientX - box.left - box.width / 2,
            y: clientY - box.top - box.height / 2,
        };

        const from = state.scale;
        const to = clampScale(absoluteScale ?? from * factor);
        const moved = anchoredTranslation(anchor, { x: state.x, y: state.y }, from, to);

        state.scale = to;
        state.x = moved.x;
        state.y = moved.y;
        clampIntoView();
        apply();
    }

    function zoomAtCentre(factor) {
        const box = contentBox();
        zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
    }

    function pinchMetrics() {
        const [a, b] = [...pointers.values()];
        return {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            // The scale at the seed. Kept for the life of the gesture: a pinch
            // that reaches the scale floor and comes back must return to where
            // it started, which per-event ratios against a shrinking baseline
            // cannot do.
            scale: state.scale,
        };
    }

    function toggleZoom(clientX, clientY) {
        if (state.scale > 1.01) {
            resetView();
            return;
        }
        zoomAt(clientX, clientY, 1, DOUBLE_TAP_SCALE);
    }

    function registerTap(clientX, clientY) {
        const now = performance.now();
        if (lastTap
            && now - lastTap.time < DOUBLE_TAP_MS
            && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) < TAP_SLOP_PX) {
            lastTap = null;
            toggleZoom(clientX, clientY);
            return;
        }
        lastTap = { time: now, x: clientX, y: clientY };
    }

    function onPointerDown(event) {
        // Ignore right and middle mouse buttons; a context menu is not a gesture.
        if (event.pointerType === "mouse" && event.button > 0) return;
        // A click on a toolbar button is not a tap on the image; without this a
        // quick double press of "+" would also trip the double-tap toggle.
        if (event.target?.closest?.(".comfyinject-lightbox-toolbar")) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        suppressClick = false;

        if (pointers.size === 1) {
            pan = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                tx: state.x,
                ty: state.y,
                moved: false,
            };
            pinch = null;
        } else if (pointers.size >= 2) {
            // A second finger means a pinch, and a pinch is never a tap. A third
            // finger re-seeds the pinch on the new pair rather than being ignored.
            pan = null;
            pinch = pinchMetrics();
            lastTap = null;
        }
    }

    function onPointerMove(event) {
        const pointer = pointers.get(event.pointerId);
        if (!pointer) return;
        pointer.x = event.clientX;
        pointer.y = event.clientY;

        if (pointers.size >= 2) {
            const next = pinchMetrics();
            if (pinch && pinch.distance > 0 && next.distance > 0) {
                // Absolute scale from the seed, so clamping at MIN_SCALE or
                // MAX_SCALE does not desynchronise the gesture from the fingers.
                zoomAt(pinch.x, pinch.y, 1, pinch.scale * (next.distance / pinch.distance));
                // Follow the midpoint as both fingers travel, so a pinch that
                // also moves pans at the same time. Anchoring on the old midpoint
                // is what makes this sum land on the correct translation.
                state.x += next.x - pinch.x;
                state.y += next.y - pinch.y;
                clampIntoView();
                apply();
            }
            // Only the midpoint advances; `distance`/`scale` stay at the seed.
            if (pinch) {
                pinch.x = next.x;
                pinch.y = next.y;
            }
            suppressClick = true;
            return;
        }

        if (!pan || pan.id !== event.pointerId) return;
        const dx = event.clientX - pan.startX;
        const dy = event.clientY - pan.startY;
        if (!pan.moved && Math.hypot(dx, dy) > DRAG_SLOP_PX) pan.moved = true;
        if (!pan.moved) return;

        state.x = pan.tx + dx;
        state.y = pan.ty + dy;
        clampIntoView();
        apply();
        overlay.classList.add("is-panning");
        suppressClick = true;
    }

    function onPointerUp(event) {
        const pointer = pointers.get(event.pointerId);
        if (!pointer) return;

        const wasSingle = pointers.size === 1;
        const moved = pan && pan.id === event.pointerId ? pan.moved : false;
        pointers.delete(event.pointerId);

        if (pointers.size >= 2) {
            // A third finger lifting re-seeds the pinch on the remaining pair.
            pinch = pinchMetrics();
            pan = null;
            return;
        }

        if (pointers.size === 1) {
            // One finger lifted from a pinch: the survivor starts a fresh pan at
            // its current position instead of jumping back to a stale origin.
            const [id, rest] = [...pointers.entries()][0];
            pan = { id, startX: rest.x, startY: rest.y, tx: state.x, ty: state.y, moved: true };
            pinch = null;
            return;
        }

        if (pointers.size === 0) {
            overlay.classList.remove("is-panning");
            if (wasSingle && !moved && event.type === "pointerup") {
                registerTap(event.clientX, event.clientY);
            }
            pan = null;
            pinch = null;
        }
    }

    function onWheel(event) {
        event.preventDefault();
        // Firefox reports lines (and some devices pages) rather than pixels; a
        // notch of 3 raw units would otherwise be a 0.4% zoom.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? overlay.clientHeight : 1;
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * unit * 0.0015));
    }

    function onContextMenu(event) {
        // A long press at the start of a pan must not raise the native image menu.
        event.preventDefault();
    }

    function onBackdropClick(event) {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        if (event.target === overlay) closeLightbox();
    }

    function onKeyDown(event) {
        if (event.key !== "Escape") return;
        // Capture phase, and stop here: the gallery and prompter overlays close
        // themselves on a bubbling Escape listener, and closing the viewer must
        // not take the gallery underneath it down too.
        event.stopPropagation();
        closeLightbox();
    }

    function onResize() {
        resetView();
        readPadding();
        measure();
    }

    const previousFocus = document.activeElement;
    overlay.tabIndex = -1;

    img.addEventListener("load", measure);
    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp);
    overlay.addEventListener("pointercancel", onPointerUp);
    overlay.addEventListener("wheel", onWheel, { passive: false });
    overlay.addEventListener("contextmenu", onContextMenu);
    overlay.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);

    teardown = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", onResize);
        previousFocus?.focus?.();
    };

    document.body.appendChild(overlay);
    readPadding();
    overlay.focus();
    apply();
    // Cached images have already loaded, so the load event may never fire.
    if (img.complete) measure();
}

/**
 * Registers the click delegation that opens the viewer. Called once from index.js.
 */
export function initLightbox() {
    injectStyle(`${VIEWER_ID}-styles`, LIGHTBOX_CSS);
    document.addEventListener("click", onDocumentClick);
    console.log("[ComfyInject] Fullscreen image viewer initialized");
}

/**
 * @param {MouseEvent} event
 */
function onDocumentClick(event) {
    // The retry affordance is a sibling of the image, but guard anyway: it must
    // regenerate, never open a viewer.
    if (event.target.closest?.(".comfyinject-retry, .comfyinject-retry-failed")) return;

    // A click that ends a text selection is not an "open this image" click.
    // Without this, dragging a selection across a message that contains an
    // image pops the viewer on mouse-up.
    if (String(window.getSelection?.() ?? "").trim()) return;

    const image = event.target.closest?.("img");
    if (!image) return;

    const inChat = image.classList.contains("custom-comfyinject-image")
        || image.classList.contains("comfyinject-image");
    // Only the gallery's detail view gets fullscreen — the thumbnail grid is
    // already a preview and clicking a card opens that detail view.
    const inGalleryDetail = !!image.closest("#comfyinject-gallery-detail");
    if (!inChat && !inGalleryDetail) return;
    if (image.closest("#comfyinject-gallery-grid")) return;

    // `img.src` on an empty attribute resolves to the document URL, so an
    // "Image unavailable" gallery entry would open a viewer of the page itself.
    openLightbox(image.getAttribute("src") || "", image.alt || "");
}
