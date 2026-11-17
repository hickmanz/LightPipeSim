/**
 * useViewerUndo.ts
 *
 * Command-pattern undo stack for the CAD viewer.
 * Each undoable action pushes a restore closure onto the stack.
 * Ctrl+Z (or the context menu) pops and executes the top entry.
 */
import { ref, computed, onBeforeUnmount, type Ref } from "vue";

export interface UndoEntry {
  label: string;
  restore: () => void;
}

const MAX_STACK_SIZE = 50;

export function useViewerUndo(guardRef?: Ref<boolean>) {
  const undoStack = ref<UndoEntry[]>([]);
  const canUndo = computed(() => undoStack.value.length > 0);

  const lastLabel = computed(() =>
    undoStack.value.length > 0
      ? undoStack.value[undoStack.value.length - 1].label
      : null,
  );

  const pushUndo = (label: string, restore: () => void) => {
    undoStack.value.push({ label, restore });
    if (undoStack.value.length > MAX_STACK_SIZE) {
      undoStack.value.shift();
    }
  };

  const undo = () => {
    const entry = undoStack.value.pop();
    if (entry) entry.restore();
  };

  const clearUndo = () => {
    undoStack.value = [];
  };

  // Global Ctrl+Z listener
  const onKeyDown = (e: KeyboardEvent) => {
    if (!((e.ctrlKey || e.metaKey) && e.key === "z")) return;
    if (e.shiftKey) return; // Don't intercept Ctrl+Shift+Z (redo)

    // Skip when typing in inputs
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((document.activeElement as HTMLElement)?.isContentEditable) return;

    // Skip when the sketch/markup undo system should take precedence
    if (guardRef?.value) return;

    if (!canUndo.value) return;

    e.preventDefault();
    e.stopPropagation();
    undo();
  };

  window.addEventListener("keydown", onKeyDown, true);

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeyDown, true);
  });

  return {
    undoStack,
    canUndo,
    lastLabel,
    pushUndo,
    undo,
    clearUndo,
  };
}
