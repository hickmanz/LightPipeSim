import { ref, type Ref, type ShallowRef } from "vue";
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { InteractionManager } from "./useInteractionManager";

export type TransformEntry = {
  instanceId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
};

export interface TransformGizmoContext {
  scene: ShallowRef<THREE.Scene | null>;
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  canvasEl: Ref<HTMLCanvasElement | null>;
  controls: ShallowRef<any | null>;
  interaction: InteractionManager;
  selectedInstanceNode: () => THREE.Object3D | null;
  getSelectedNodes: () => THREE.Object3D[];
  findNodeByInstanceId: (id: string) => THREE.Object3D | null;
  updateClippingFromBounds: () => void;
  refreshSectionCaps: () => void;
}

export function useTransformGizmo(ctx: TransformGizmoContext) {
  // ── State ──
  let onGizmoDragEndCb: ((preDrags: TransformEntry[]) => void) | null = null;
  let gizmo: TransformControls | null = null;
  const transformGizmoActive = ref(false);
  const transformGizmoMode = ref<"translate" | "rotate">("translate");
  const transformedNodes = new Map<
    string,
    {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
      scale: { x: number; y: number; z: number };
    }
  >();
  const transformOriginals = new Map<
    string,
    { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }
  >();

  // Multi-select drag: companion nodes that move/rotate alongside the gizmo target
  let companions: {
    node: THREE.Object3D;
    startPos: THREE.Vector3;
    startQuat: THREE.Quaternion;
  }[] = [];
  let primaryDragStart: THREE.Vector3 | null = null;
  let primaryDragStartQuat: THREE.Quaternion | null = null;

  // ── Internal helpers ──

  /** Create or return the existing TransformControls instance. */
  const ensureGizmo = (): TransformControls | null => {
    if (gizmo) return gizmo;
    if (!ctx.camera.value || !ctx.canvasEl.value) return null;

    const tc = new TransformControls(ctx.camera.value, ctx.canvasEl.value);
    tc.setMode("translate");
    tc.setSize(1);

    let preDragTransforms: TransformEntry[] = [];
    tc.addEventListener("dragging-changed", (event: any) => {
      if (event.value) {
        ctx.interaction.suppress("orbit");
      } else {
        ctx.interaction.unsuppress("orbit");
      }
      if (event.value) {
        const obj = tc.object;
        if (obj) {
          // Capture pre-drag for primary node
          preDragTransforms = [];
          const iid = obj.userData?.cadreview_instanceId;
          if (iid) {
            preDragTransforms.push({
              instanceId: iid,
              position: {
                x: obj.position.x,
                y: obj.position.y,
                z: obj.position.z,
              },
              rotation: {
                x: obj.rotation.x,
                y: obj.rotation.y,
                z: obj.rotation.z,
              },
              scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
            });
          }
          // Capture start state for multi-select companion movement
          primaryDragStart = obj.position.clone();
          primaryDragStartQuat = obj.quaternion.clone();
          const allSelected = ctx.getSelectedNodes();
          companions = allSelected
            .filter((n) => n !== obj)
            .map((n) => ({
              node: n,
              startPos: n.position.clone(),
              startQuat: n.quaternion.clone(),
            }));
          for (const { node } of companions) {
            const cid = node.userData?.cadreview_instanceId;
            if (cid) {
              // Capture pre-drag for companion
              preDragTransforms.push({
                instanceId: cid,
                position: {
                  x: node.position.x,
                  y: node.position.y,
                  z: node.position.z,
                },
                rotation: {
                  x: node.rotation.x,
                  y: node.rotation.y,
                  z: node.rotation.z,
                },
                scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
              });
              if (!transformOriginals.has(cid)) {
                transformOriginals.set(cid, {
                  position: node.position.clone(),
                  rotation: node.rotation.clone(),
                  scale: node.scale.clone(),
                });
              }
            }
          }
        }
      } else {
        // Record final positions for companions
        for (const { node } of companions) {
          const cid = node.userData?.cadreview_instanceId;
          if (cid) {
            transformedNodes.set(cid, {
              position: {
                x: node.position.x,
                y: node.position.y,
                z: node.position.z,
              },
              rotation: {
                x: node.rotation.x,
                y: node.rotation.y,
                z: node.rotation.z,
              },
              scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
            });
          }
        }
        companions = [];
        primaryDragStart = null;
        primaryDragStartQuat = null;

        ctx.interaction.consumeNextClick();
        ctx.refreshSectionCaps();
        ctx.updateClippingFromBounds();
        if (preDragTransforms.length > 0) {
          onGizmoDragEndCb?.(preDragTransforms);
          preDragTransforms = [];
        }
      }
    });

    tc.addEventListener("objectChange", () => {
      const obj = tc.object;
      if (!obj) return;
      const iid = obj.userData?.cadreview_instanceId;
      if (!iid) return;

      const isRotating = tc.mode === "rotate";

      transformedNodes.set(iid, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });

      if (companions.length === 0) return;

      if (isRotating && primaryDragStartQuat) {
        // Rigid group rotation: use the (already amplified) delta for companions
        const rotDelta = obj.quaternion
          .clone()
          .multiply(primaryDragStartQuat.clone().invert());
        const pivot = primaryDragStart!;

        for (const { node, startPos, startQuat } of companions) {
          node.quaternion.copy(rotDelta.clone().multiply(startQuat));

          const offset = startPos.clone().sub(pivot);
          offset.applyQuaternion(rotDelta);
          node.position.copy(pivot).add(offset);

          const cid = node.userData?.cadreview_instanceId;
          if (cid) {
            transformedNodes.set(cid, {
              position: {
                x: node.position.x,
                y: node.position.y,
                z: node.position.z,
              },
              rotation: {
                x: node.rotation.x,
                y: node.rotation.y,
                z: node.rotation.z,
              },
              scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
            });
          }
        }
      } else if (primaryDragStart) {
        const delta = obj.position.clone().sub(primaryDragStart);
        for (const { node, startPos } of companions) {
          node.position.copy(startPos).add(delta);
          const cid = node.userData?.cadreview_instanceId;
          if (cid) {
            transformedNodes.set(cid, {
              position: {
                x: node.position.x,
                y: node.position.y,
                z: node.position.z,
              },
              rotation: {
                x: node.rotation.x,
                y: node.rotation.y,
                z: node.rotation.z,
              },
              scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
            });
          }
        }
      }
    });

    const handleGizmoKeyDown = (e: KeyboardEvent) => {
      if (!tc.object) return;
      if (e.key === "r" || e.key === "R") {
        tc.setMode("rotate");
        transformGizmoMode.value = "rotate";
      } else if (e.key === "g" || e.key === "G") {
        tc.setMode("translate");
        transformGizmoMode.value = "translate";
      }
    };
    window.addEventListener("keydown", handleGizmoKeyDown);
    (tc as any)._keyHandler = handleGizmoKeyDown;

    if (ctx.scene.value) ctx.scene.value.add(tc.getHelper());
    gizmo = tc;
    return tc;
  };

  // ── Public API ──

  const detachTransformGizmo = () => {
    if (gizmo && gizmo.object) {
      gizmo.detach();
    }
    transformGizmoActive.value = false;
  };

  const disposeTransformGizmo = () => {
    if (!gizmo) return;
    const kh = (gizmo as any)._keyHandler;
    if (kh) window.removeEventListener("keydown", kh);
    gizmo.detach();
    if (ctx.scene.value) ctx.scene.value.remove(gizmo.getHelper());
    gizmo.dispose();
    gizmo = null;
    transformGizmoActive.value = false;
    transformedNodes.clear();
    transformOriginals.clear();
  };

  const showHandles = () => {
    const selected = ctx.selectedInstanceNode();
    if (!selected) return;

    const tc = ensureGizmo();
    if (!tc) return;

    if (tc.object === selected) {
      detachTransformGizmo();
      return;
    }

    // Save originals for all selected nodes (primary + companions)
    for (const node of ctx.getSelectedNodes()) {
      const iid = node.userData?.cadreview_instanceId;
      if (iid && !transformOriginals.has(iid)) {
        transformOriginals.set(iid, {
          position: node.position.clone(),
          rotation: node.rotation.clone(),
          scale: node.scale.clone(),
        });
      }
    }

    tc.attach(selected);
    transformGizmoActive.value = true;
    transformGizmoMode.value = tc.mode as "translate" | "rotate";
  };

  const getTransformedNodes = (): TransformEntry[] => {
    const result: TransformEntry[] = [];
    for (const [instanceId, t] of transformedNodes) {
      result.push({ instanceId, ...t });
    }
    return result;
  };

  const restoreTransformedNodes = (
    nodes: TransformEntry[],
    animateDuration = 0,
  ): Promise<void> => {
    if (nodes.length === 0) return Promise.resolve();

    const targets: {
      obj: THREE.Object3D;
      startPos: THREE.Vector3;
      startRot: THREE.Euler;
      startScale: THREE.Vector3;
      endPos: THREE.Vector3;
      endRot: THREE.Euler;
      endScale: THREE.Vector3;
    }[] = [];

    for (const { instanceId, position, rotation, scale } of nodes) {
      const obj = ctx.findNodeByInstanceId(instanceId);
      if (!obj) continue;
      if (!transformOriginals.has(instanceId)) {
        transformOriginals.set(instanceId, {
          position: obj.position.clone(),
          rotation: obj.rotation.clone(),
          scale: obj.scale.clone(),
        });
      }
      targets.push({
        obj,
        startPos: obj.position.clone(),
        startRot: obj.rotation.clone(),
        startScale: obj.scale.clone(),
        endPos: new THREE.Vector3(position.x, position.y, position.z),
        endRot: new THREE.Euler(rotation.x, rotation.y, rotation.z),
        endScale: new THREE.Vector3(scale.x, scale.y, scale.z),
      });
      transformedNodes.set(instanceId, { position, rotation, scale });
    }

    if (animateDuration <= 0 || targets.length === 0) {
      for (const { obj, endPos, endRot, endScale } of targets) {
        obj.position.copy(endPos);
        obj.rotation.copy(endRot);
        obj.scale.copy(endScale);
      }
      ctx.updateClippingFromBounds();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const durationMs = animateDuration * 1000;
      const t0 = performance.now();
      const ease = (t: number) => t * t * (3 - 2 * t);
      const startQuats = targets.map(({ startRot }) =>
        new THREE.Quaternion().setFromEuler(startRot),
      );
      const endQuats = targets.map(({ endRot }) =>
        new THREE.Quaternion().setFromEuler(endRot),
      );
      const tmpQuat = new THREE.Quaternion();

      const tick = () => {
        const elapsed = performance.now() - t0;
        const raw = Math.min(elapsed / durationMs, 1);
        const t = ease(raw);

        for (let i = 0; i < targets.length; i++) {
          const { obj, startPos, endPos, startScale, endScale } = targets[i];
          obj.position.lerpVectors(startPos, endPos, t);
          tmpQuat.slerpQuaternions(startQuats[i], endQuats[i], t);
          obj.rotation.setFromQuaternion(tmpQuat);
          obj.scale.lerpVectors(startScale, endScale, t);
        }

        if (raw < 1) {
          requestAnimationFrame(tick);
        } else {
          for (const { obj, endPos, endRot, endScale } of targets) {
            obj.position.copy(endPos);
            obj.rotation.copy(endRot);
            obj.scale.copy(endScale);
          }
          ctx.updateClippingFromBounds();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  };

  const setOnGizmoDragEnd = (
    cb: ((preDrags: TransformEntry[]) => void) | null,
  ) => {
    onGizmoDragEndCb = cb;
  };

  const isGizmoActive = (): boolean => !!(gizmo && gizmo.object);

  /** Restore all nodes to their original transforms (before any gizmo drags). */
  const restoreOriginalTransforms = () => {
    for (const [instanceId, orig] of transformOriginals) {
      const obj = ctx.findNodeByInstanceId(instanceId);
      if (obj) {
        obj.position.copy(orig.position);
        obj.rotation.copy(orig.rotation);
        obj.scale.copy(orig.scale);
      }
    }
  };

  /** Clear both the live-tracking and originals maps. */
  const clearTransformState = () => {
    transformOriginals.clear();
    transformedNodes.clear();
  };

  return {
    transformGizmoActive,
    transformGizmoMode,
    showHandles,
    detachTransformGizmo,
    disposeTransformGizmo,
    getTransformedNodes,
    restoreTransformedNodes,
    setOnGizmoDragEnd,
    isGizmoActive,
    restoreOriginalTransforms,
    clearTransformState,
  };
}
