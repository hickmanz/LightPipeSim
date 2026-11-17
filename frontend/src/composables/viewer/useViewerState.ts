import type { CameraViewState } from "./useThreeViewer";
import type { SectionSnapshot } from "../../types/section";

// ---------------------------------------------------------------------------
// Full viewer state snapshot
// ---------------------------------------------------------------------------

/**
 * Combined snapshot of all viewer sub-system states.
 * Extend this as new domains (visibility, transparency, markup) are added.
 */
export interface FullViewerState {
  camera: CameraViewState;
  section: SectionSnapshot | null;
  // Future fields:
  // visibility: VisibilityState | null;
  // transparency: TransparencyState | null;
  // markup: MarkupState | null;
}

// ---------------------------------------------------------------------------
// Context – what the aggregator needs from each sub-system
// ---------------------------------------------------------------------------

export interface ViewerStateContext {
  getCameraState: () => CameraViewState | null;
  restoreCameraState: (state: CameraViewState) => void;
  getSectionState: () => SectionSnapshot;
  restoreSectionState: (snapshot: SectionSnapshot) => void;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Aggregator composable that combines all viewer sub-system states into a
 * single serializable snapshot for save/restore.
 *
 * Each feature domain (camera, section planes, visibility, etc.) owns its own
 * state capture / restore logic. This composable simply orchestrates them.
 */
export function useViewerState(context: ViewerStateContext) {
  /**
   * Capture the full viewer state as a single serializable object.
   * Returns `null` if the camera is not yet ready.
   */
  const captureFullState = (): FullViewerState | null => {
    const camera = context.getCameraState();
    if (!camera) return null;

    let section: SectionSnapshot | null = null;
    try {
      section = context.getSectionState();
    } catch {
      // Section planes may not be initialised yet
    }

    return { camera, section };
  };

  /**
   * Restore the full viewer state from a previously captured snapshot.
   * Restores camera first, then section planes.
   */
  const restoreFullState = (state: FullViewerState): void => {
    // Camera first – projection switch may recreate controls
    context.restoreCameraState(state.camera);

    // Section planes
    if (state.section) {
      context.restoreSectionState(state.section);
    }
  };

  return {
    captureFullState,
    restoreFullState,
  };
}
