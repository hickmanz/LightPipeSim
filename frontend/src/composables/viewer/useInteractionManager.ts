/**
 * useInteractionManager.ts
 *
 * Centralized interaction mode manager for the Three.js viewer.
 * Maintains a single source of truth for which input channels (orbit, pan,
 * part selection, etc.) are active at any given time based on the current
 * tool mode, plus transient suppressions for short-lived overrides like
 * section-plane or gizmo drags.
 */
import {
  ref,
  reactive,
  computed,
  readonly,
  type DeepReadonly,
  type Ref,
} from "vue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolMode =
  | "default"
  | "measure"
  | "markup2d"
  | "noteMarkup"
  | "sequentialHide"
  | "capture";

export type InputChannel =
  | "orbit"
  | "pan"
  | "partSelect"
  | "partHover"
  | "brepHover";

// ---------------------------------------------------------------------------
// Mode-to-channel map (single source of truth)
// ---------------------------------------------------------------------------

const MODE_CHANNELS: Record<ToolMode, ReadonlySet<InputChannel>> = {
  default: new Set(["orbit", "pan", "partSelect", "partHover"]),
  measure: new Set(["orbit", "pan", "brepHover"]),
  markup2d: new Set([]),
  noteMarkup: new Set(["orbit", "pan"]),
  sequentialHide: new Set([]),
  capture: new Set(["orbit", "pan"]),
};

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export interface InteractionManager {
  /** The currently active tool mode (reactive, read-only). */
  activeMode: DeepReadonly<Ref<ToolMode>>;

  /**
   * Reactive predicate: returns `true` when `channel` is permitted by the
   * current mode AND not transiently suppressed.
   */
  isAllowed: (channel: InputChannel) => boolean;

  /** Switch to a new tool mode. Replaces the current mode outright. */
  setMode: (mode: ToolMode) => void;

  /** Shorthand for `setMode('default')`. */
  resetMode: () => void;

  /** Transiently block a channel (e.g. during a gizmo drag). */
  suppress: (channel: InputChannel) => void;

  /** Remove a transient block previously added via `suppress`. */
  unsuppress: (channel: InputChannel) => void;

  /**
   * Mark the next synthesized `click` event as consumed so that all
   * click-driven handlers (part selection, pin selection, etc.) ignore it.
   * Call at the end of any pointer gesture (section-plane drag, gizmo drag,
   * pin placement) whose trailing click should not trigger selection.
   * The flag auto-clears on the next animation frame.
   */
  consumeNextClick: () => void;

  /** Returns `true` while a `consumeNextClick` flag is still active. */
  isClickConsumed: () => boolean;
}

export function useInteractionManager(): InteractionManager {
  const activeMode = ref<ToolMode>("default");
  const suppressedChannels = reactive(new Set<InputChannel>());

  let clickConsumed = false;
  let clearRafId: number | null = null;

  const allowed = computed(() => {
    const modeChannels = MODE_CHANNELS[activeMode.value];
    const suppressed = new Set(suppressedChannels);
    return (channel: InputChannel): boolean => {
      if (suppressed.has(channel)) return false;
      return modeChannels?.has(channel) ?? false;
    };
  });

  function setMode(mode: ToolMode): void {
    activeMode.value = mode;
  }

  function resetMode(): void {
    activeMode.value = "default";
  }

  function suppress(channel: InputChannel): void {
    suppressedChannels.add(channel);
  }

  function unsuppress(channel: InputChannel): void {
    suppressedChannels.delete(channel);
  }

  function consumeNextClick(): void {
    clickConsumed = true;
    if (clearRafId != null) cancelAnimationFrame(clearRafId);
    clearRafId = requestAnimationFrame(() => {
      clickConsumed = false;
      clearRafId = null;
    });
  }

  function isClickConsumed(): boolean {
    return clickConsumed;
  }

  return {
    activeMode: readonly(activeMode),
    isAllowed: (channel: InputChannel) => allowed.value(channel),
    setMode,
    resetMode,
    suppress,
    unsuppress,
    consumeNextClick,
    isClickConsumed,
  };
}
