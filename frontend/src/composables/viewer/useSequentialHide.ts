/**
 * useSequentialHide.ts
 *
 * Sequential-hide mode for the Three.js viewer.
 * While active, every left-click on a part hides it immediately.
 * The mode exits on: click empty space, right-click, Escape, or the
 * banner close button (handled externally via `deactivate()`).
 */
import { ref, type Ref, type ShallowRef } from "vue";
import * as THREE from "three";
import type { InteractionManager } from "./useInteractionManager";

// ---------------------------------------------------------------------------
// Context type — everything the composable needs from the host viewer
// ---------------------------------------------------------------------------

export interface SequentialHideContext {
  canvasEl: Ref<HTMLCanvasElement | null>;
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  loadedModel: ShallowRef<THREE.Object3D | null>;
  cursorLocked: Ref<boolean>;
  interaction: InteractionManager;
  /** Raycast from a pointer event and return filtered intersections. */
  raycastFromCursor: (event: MouseEvent | PointerEvent) => THREE.Intersection[];
  /** Walk up scene graph to the nearest instance node. */
  findParentInstanceNode: (obj: THREE.Object3D) => THREE.Object3D | null;
  /** Set visibility for a node (and descendants) by its Three.js object id. */
  setNodeVisibility: (nodeId: number, visible: boolean) => void;
  /** Refresh section-plane caps after visibility changes. */
  refreshCaps: () => void;
  /** Callback invoked after each hide so the host can rebuild the model tree. */
  onNodeHidden?: () => void;
  /** Callback invoked before a node is hidden (receives the node id for undo). */
  onBeforeNodeHidden?: (nodeId: number) => void;
}

// ---------------------------------------------------------------------------
// EyeOff cursor (Lucide `eye-off` icon encoded as a data-URI)
// ---------------------------------------------------------------------------

const EYE_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;

function buildCursorUrl(): string {
  const encoded = encodeURIComponent(EYE_OFF_SVG);
  return `url("data:image/svg+xml,${encoded}") 12 12, pointer`;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useSequentialHide(context: SequentialHideContext) {
  const sequentialHideActive = ref(false);

  let previousCursor = "";
  // Track pointer-down position to distinguish click from drag
  let pointerDownX = 0;
  let pointerDownY = 0;
  const CLICK_THRESHOLD_PX = 5;

  // ------------------------------------------------------------------
  // Pointer handlers (capture-phase — fire before orbit / selection)
  // ------------------------------------------------------------------

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // Only left-click
    e.stopPropagation();
    e.preventDefault();
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return; // Only left-click
    e.stopPropagation();
    e.preventDefault();

    // Ignore if the pointer moved too far (it was a drag, not a click)
    const dx = e.clientX - pointerDownX;
    const dy = e.clientY - pointerDownY;
    if (Math.sqrt(dx * dx + dy * dy) > CLICK_THRESHOLD_PX) return;

    // Raycast to find what was clicked
    const intersects = context.raycastFromCursor(e);
    if (intersects.length > 0) {
      const instanceNode = context.findParentInstanceNode(intersects[0].object);
      if (instanceNode) {
        context.onBeforeNodeHidden?.(instanceNode.id);
        context.setNodeVisibility(instanceNode.id, false);
        context.refreshCaps();
        context.onNodeHidden?.();
      }
    } else {
      // Click on empty space → exit mode
      deactivate();
    }
  };

  // Consume pointer-move so orbit controls don't engage during left-drag
  const onPointerMove = (e: PointerEvent) => {
    // Only consume when left button is held (buttons bitmask bit 0)
    if (e.buttons & 1) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  // Consume the synthesized `click` event so the viewer's handleClick
  // (selection) never fires while sequential hide mode is active.
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  // Right-click → exit mode (suppress context menu)
  const onContextMenu = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    deactivate();
  };

  // Escape key → exit mode
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      deactivate();
    }
  };

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  const activate = () => {
    if (sequentialHideActive.value) return;

    const canvas = context.canvasEl.value;
    if (!canvas) return;

    // Save & set cursor
    previousCursor = canvas.style.cursor;
    canvas.style.cursor = buildCursorUrl();
    context.cursorLocked.value = true;

    // Capture-phase listeners (fire before orbit / selection handlers)
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("pointerup", onPointerUp, true);
    canvas.addEventListener("pointermove", onPointerMove, true);
    canvas.addEventListener("click", onClick, true);
    canvas.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown);

    sequentialHideActive.value = true;
    context.interaction.setMode("sequentialHide");
    console.log("[useSequentialHide] Mode activated");
  };

  const deactivate = () => {
    if (!sequentialHideActive.value) return;

    const canvas = context.canvasEl.value;
    if (canvas) {
      canvas.style.cursor = previousCursor;
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointerup", onPointerUp, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
      canvas.removeEventListener("click", onClick, true);
      canvas.removeEventListener("contextmenu", onContextMenu, true);
    }
    document.removeEventListener("keydown", onKeyDown);

    context.cursorLocked.value = false;
    sequentialHideActive.value = false;
    context.interaction.resetMode();
    console.log("[useSequentialHide] Mode deactivated");
  };

  return {
    sequentialHideActive,
    activate,
    deactivate,
  };
}
