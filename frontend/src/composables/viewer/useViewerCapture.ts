import { ref, onBeforeUnmount, type Ref, type ShallowRef } from "vue";
import type * as THREE from "three";
import type { InteractionManager } from "./useInteractionManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewerCaptureContext {
  renderer: ShallowRef<THREE.WebGLRenderer | null>;
  scene: ShallowRef<THREE.Scene | null>;
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  interaction: InteractionManager;
  /** Owned by the caller; this composable reads and writes it. */
  captureActive: Ref<boolean>;
  getOverlayCanvas: () => HTMLCanvasElement | null;
  deactivateRedlineOperator: () => void;
  trashSessionMarkups: () => void;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useViewerCapture(context: ViewerCaptureContext) {
  const captureActive = context.captureActive;
  const screenshotToast = ref(false);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function enterCaptureMode() {
    if (captureActive.value) return;
    context.deactivateRedlineOperator();
    context.trashSessionMarkups();
    captureActive.value = true;
    context.interaction.setMode("capture");
  }

  function exitCaptureMode() {
    if (!captureActive.value) return;
    context.deactivateRedlineOperator();
    context.trashSessionMarkups();
    captureActive.value = false;
    context.interaction.resetMode();
  }

  async function takeScreenshot(): Promise<Blob | null> {
    const r = context.renderer.value;
    const s = context.scene.value;
    const c = context.camera.value;
    if (!r || !s || !c) {
      console.error(
        "[useViewerCapture] Cannot take screenshot: viewer not ready",
      );
      return null;
    }

    r.render(s, c);

    const width = r.domElement.width;
    const height = r.domElement.height;
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d");
    if (!ctx) {
      console.error(
        "[useViewerCapture] Failed to get 2d context from OffscreenCanvas",
      );
      return null;
    }

    ctx.drawImage(r.domElement, 0, 0);

    const overlayEl = context.getOverlayCanvas();
    if (overlayEl) {
      ctx.drawImage(overlayEl, 0, 0, width, height);
    }

    try {
      return await offscreen.convertToBlob({ type: "image/png" });
    } catch (err) {
      console.error(
        "[useViewerCapture] Failed to convert canvas to blob:",
        err,
      );
      return null;
    }
  }

  async function copyScreenshotToClipboard(): Promise<boolean> {
    const blob = await takeScreenshot();
    if (!blob) return false;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      showToast();
      return true;
    } catch (err) {
      console.warn(
        "[useViewerCapture] Clipboard write failed, falling back to download:",
        err,
      );
      downloadBlob(blob, `screenshot-${Date.now()}.png`);
      showToast();
      return true;
    }
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function showToast() {
    screenshotToast.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      screenshotToast.value = false;
      toastTimer = null;
    }, 3000);
  }

  async function captureAndExit() {
    const success = await copyScreenshotToClipboard();
    exitCaptureMode();
    return success;
  }

  onBeforeUnmount(() => {
    if (captureActive.value) exitCaptureMode();
    if (toastTimer) clearTimeout(toastTimer);
  });

  return {
    captureActive,
    screenshotToast,
    enterCaptureMode,
    exitCaptureMode,
    takeScreenshot,
    copyScreenshotToClipboard,
    captureAndExit,
  };
}
