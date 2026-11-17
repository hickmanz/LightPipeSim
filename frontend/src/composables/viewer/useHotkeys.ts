/**
 * useHotkeys.ts
 *
 * Centralized, registry-based hotkey system for the viewer.
 * Manages a single capture-phase keydown listener and a reactive registry
 * of hotkey definitions filtered by the current InteractionManager mode.
 */
import { ref, computed, triggerRef, type ComputedRef } from "vue";
import type { InteractionManager, ToolMode } from "./useInteractionManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HotkeyDefinition {
  /** Unique identifier, e.g. "viewer-hide" */
  id: string;
  /** Key combo string, e.g. "ctrl+z", "escape", "h", "LMB Drag" */
  keys: string;
  /** Display label for the overlay, e.g. "Hide Selected" */
  label: string;
  /** Category for UI grouping, e.g. "Selection", "Navigation" */
  category: string;
  /** Callback — omitted for displayOnly entries */
  action?: () => void;
  /** If true, shown in overlay only — never dispatched by keydown */
  displayOnly?: boolean;
  /** Which interaction modes this applies in (default: "all") */
  modes?: ToolMode[] | "all";
  /** Pure, side-effect-free runtime guard (e.g. selection required) */
  when?: () => boolean;
  /** Conflict resolution — higher wins (default: 0). Ties: first registered wins. */
  priority?: number;
}

export interface HotkeyContext {
  interaction: InteractionManager;
}

export interface Hotkeys {
  /** Register a hotkey definition. Returns an unregister function. */
  register(def: HotkeyDefinition): () => void;
  /** Unregister a hotkey by id. */
  unregister(id: string): void;
  /** Hotkeys active for the current interaction mode (includes displayOnly). */
  activeHotkeys: ComputedRef<HotkeyDefinition[]>;
  /** All registered hotkeys regardless of mode. */
  allHotkeys: ComputedRef<HotkeyDefinition[]>;
  /** Remove the global keydown listener. Call in onBeforeUnmount. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParsedCombo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parseCombo(keys: string): ParsedCombo {
  const parts = keys
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  return {
    ctrl:
      parts.includes("ctrl") || parts.includes("meta") || parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key:
      parts.filter(
        (p) => !["ctrl", "meta", "mod", "shift", "alt"].includes(p),
      )[0] ?? "",
  };
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  space: " ",
};

function normalizeEventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  return KEY_ALIASES[k] ?? k;
}

function comboMatchesEvent(combo: ParsedCombo, e: KeyboardEvent): boolean {
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (combo.ctrl !== ctrlOrMeta) return false;
  if (combo.shift !== e.shiftKey) return false;
  if (combo.alt !== e.altKey) return false;
  return normalizeEventKey(e) === combo.key;
}

function isTextInput(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useHotkeys(ctx: HotkeyContext): Hotkeys {
  const registry = new Map<string, HotkeyDefinition>();
  const version = ref(0);

  const bump = () => {
    version.value++;
    triggerRef(version);
  };

  // ── Keydown handler ──

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTextInput()) return;

    const mode = ctx.interaction.activeMode.value;

    const candidates: { def: HotkeyDefinition; priority: number }[] = [];

    for (const def of registry.values()) {
      if (def.displayOnly) continue;
      if (!def.action) continue;

      const modes = def.modes ?? "all";
      if (modes !== "all" && !modes.includes(mode)) continue;

      const combo = parseCombo(def.keys);
      if (!comboMatchesEvent(combo, e)) continue;

      try {
        if (def.when && !def.when()) continue;
      } catch (err) {
        console.error(
          `[useHotkeys] Error in when() guard for "${def.id}":`,
          err,
        );
        continue;
      }

      candidates.push({ def, priority: def.priority ?? 0 });
    }

    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.priority - a.priority);

    const winner = candidates[0]!;

    e.preventDefault();
    e.stopPropagation();

    try {
      winner.def.action!();
    } catch (err) {
      console.error(
        `[useHotkeys] Error in action() for "${winner.def.id}":`,
        err,
      );
    }
  };

  window.addEventListener("keydown", onKeyDown, true);

  // ── Registry API ──

  function register(def: HotkeyDefinition): () => void {
    registry.set(def.id, def);
    bump();
    return () => unregister(def.id);
  }

  function unregister(id: string): void {
    if (registry.delete(id)) {
      bump();
    }
  }

  // ── Computed views ──

  const allHotkeys = computed<HotkeyDefinition[]>(() => {
    void version.value;
    return [...registry.values()];
  });

  const activeHotkeys = computed<HotkeyDefinition[]>(() => {
    void version.value;
    const mode = ctx.interaction.activeMode.value;

    return [...registry.values()].filter((def) => {
      const modes = def.modes ?? "all";
      if (modes !== "all" && !modes.includes(mode)) return false;

      if (def.when) {
        try {
          if (!def.when()) return false;
        } catch {
          return false;
        }
      }
      return true;
    });
  });

  // ── Teardown ──

  function dispose(): void {
    window.removeEventListener("keydown", onKeyDown, true);
    registry.clear();
    bump();
  }

  return {
    register,
    unregister,
    activeHotkeys,
    allHotkeys,
    dispose,
  };
}
