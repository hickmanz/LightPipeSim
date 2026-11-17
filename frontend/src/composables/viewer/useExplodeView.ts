import { type Ref, type ShallowRef } from "vue";
import * as THREE from "three";

export interface ExplodeViewContext {
  scene: ShallowRef<THREE.Scene | null>;
  loadedModel: ShallowRef<THREE.Object3D | null>;
  getModelBoundingBox: () => THREE.Box3 | null;
  getSelectedNodeIds: () => number[];
  isSignificantChild: (child: THREE.Object3D) => boolean;
  updateClippingFromBounds: () => void;
  refreshSectionCaps: () => void;
}

/**
 * Composable for managing the exploded-view feature in the Three.js viewer.
 * Handles axis-based explosion, bounding-box computation, ranking, and debug
 * visualization of per-part bounding boxes.
 */
export function useExplodeView(ctx: ExplodeViewContext) {
  // ── State ──
  let explodeMagnitude = 0;
  const explodeOriginals = new Map<THREE.Object3D, THREE.Vector3>();
  const explodeDirections = new Map<THREE.Object3D, THREE.Vector3>();
  let explodeScaleFactor = 1;

  /**
   * Axis-based explosion: parts slide along a chosen axis (X/Y/Z) away from
   * the model bounding-box center (datum origin).  Each part's signed distance
   * from that center along the axis determines direction and magnitude.
   *
   * Directions are in the parent's local coordinate space so that position
   * offsets work correctly regardless of ancestor transforms.
   */
  let currentExplodeAxis: "x" | "y" | "z" = "x";

  // Debug bounding box visualization
  let debugBBoxHelpers: THREE.Box3Helper[] = [];

  // ── Helpers ──

  const clearDebugBBoxes = () => {
    for (const h of debugBBoxHelpers) {
      h.parent?.remove(h);
      h.geometry?.dispose();
      if (h.material instanceof THREE.Material) h.material.dispose();
    }
    debugBBoxHelpers = [];
  };

  /**
   * Compute a world-space AABB that only includes visible mesh geometry,
   * skipping hidden meshes, edge lines, outline helpers, and debug helpers.
   * Recomputes bounds from raw vertex positions to avoid BVH padding artifacts,
   * and skips degenerate meshes (low vertex count with huge extent).
   */
  const getVisibleBBox = (obj: THREE.Object3D): THREE.Box3 => {
    const box = new THREE.Box3();
    const _v = new THREE.Vector3();
    obj.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (!node.visible) return;
      if (
        node.userData?.isFatEdgeLine ||
        node.userData?._isOutlineHelper ||
        node.userData?._isDebugHelper
      )
        return;
      const pos = node.geometry?.attributes?.position;
      if (!pos) return;

      const localBox = new THREE.Box3();
      for (let i = 0, l = pos.count; i < l; i++) {
        _v.fromBufferAttribute(pos, i);
        localBox.expandByPoint(_v);
      }
      if (localBox.isEmpty()) return;

      const worldBox = localBox.clone().applyMatrix4(node.matrixWorld);
      const worldSize = worldBox.getSize(new THREE.Vector3());
      const worldMaxDim = Math.max(worldSize.x, worldSize.y, worldSize.z);
      const worldMinDim = Math.min(worldSize.x, worldSize.y, worldSize.z);

      // Skip degenerate meshes from CAD conversion: huge nearly-cubic bounding
      // boxes that don't correspond to real geometry (test points, capacitors, etc.
      // where the converter outputs vertex positions at extreme coordinates).
      // Real large geometry is flat/elongated (PCB boards, shield frames), not cubic.
      if (worldMaxDim > 30 && worldMinDim / worldMaxDim > 0.7) {
        return;
      }

      box.union(worldBox);
    });
    return box;
  };

  const hasVisibleMesh = (obj: THREE.Object3D): boolean => {
    if (
      obj instanceof THREE.Mesh &&
      obj.visible &&
      !obj.userData?.isFatEdgeLine &&
      !obj.userData?._isOutlineHelper &&
      !obj.userData?._isDebugHelper
    ) {
      return true;
    }
    for (const child of obj.children) {
      if (hasVisibleMesh(child)) return true;
    }
    return false;
  };

  // ── Debug visualization ──

  const showDebugBBoxes = () => {
    clearDebugBBoxes();
    if (!ctx.loadedModel.value || !ctx.scene.value) return;

    ctx.scene.value.updateMatrixWorld(true);

    let container: THREE.Object3D = ctx.loadedModel.value;
    let significant = container.children.filter(ctx.isSignificantChild);
    while (significant.length === 1) {
      container = significant[0];
      significant = container.children.filter(ctx.isSignificantChild);
    }

    const targets = significant.filter(hasVisibleMesh);

    const colors = [
      0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800,
      0x8800ff, 0x00ff88, 0xff0088, 0x88ff00, 0x0088ff,
    ];

    console.log(
      `[BBox Debug] ===== START ===== ${targets.length} visible targets`,
    );

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];

      const fullBox = new THREE.Box3().setFromObject(t);
      const visBox = getVisibleBBox(t);

      const box = visBox.isEmpty() ? fullBox : visBox;
      if (box.isEmpty()) continue;

      const size = box.getSize(new THREE.Vector3());
      const vSize = visBox.isEmpty()
        ? null
        : visBox.getSize(new THREE.Vector3());
      const color = colors[i % colors.length];

      const sizeStr = `size=(${size.x.toFixed(1)}, ${size.y.toFixed(1)}, ${size.z.toFixed(1)})`;
      const vSizeStr = vSize
        ? `visSize=(${vSize.x.toFixed(1)}, ${vSize.y.toFixed(1)}, ${vSize.z.toFixed(1)})`
        : "visSize=EMPTY";
      console.log(`[BBox Debug] "${t.name}"  ${sizeStr}  ${vSizeStr}`);

      if (size.z > 100 || size.x > 100 || size.y > 100) {
        console.group(`[BBox Debug] ALL descendants of "${t.name}":`);
        let count = 0;
        t.traverse((node) => {
          if (node === t) return;
          const type = node.constructor.name;
          const hasGeo = "geometry" in node && (node as any).geometry;
          let boundsStr = "";
          if (hasGeo) {
            const geo = (node as any).geometry;
            if (geo.attributes?.position) {
              if (!geo.boundingBox) geo.computeBoundingBox();
              if (geo.boundingBox) {
                const wb = geo.boundingBox
                  .clone()
                  .applyMatrix4(node.matrixWorld);
                const ws = wb.getSize(new THREE.Vector3());
                boundsStr = `  worldSize=(${ws.x.toFixed(1)}, ${ws.y.toFixed(1)}, ${ws.z.toFixed(1)})  verts=${geo.attributes.position.count}`;
              }
            }
          }
          const vis = node.visible ? "VIS" : "HID";
          const ud = node.userData ? Object.keys(node.userData).join(",") : "";
          console.log(
            `  [${vis}] ${type} "${node.name || `id:${node.id}`}" ud={${ud}}${boundsStr}`,
          );
          count++;
        });
        console.log(`  (${count} total descendants)`);
        console.groupEnd();
      }

      const helper = new THREE.Box3Helper(box, new THREE.Color(color));
      helper.userData._isDebugHelper = true;
      ctx.scene.value.add(helper);
      debugBBoxHelpers.push(helper);
    }

    console.log(`[BBox Debug] ===== END =====`);
  };

  // ── Core explode logic ──

  interface ExplodeEntry {
    target: THREE.Object3D;
    sign: 1 | -1;
    axMin: number;
    axMax: number;
    compositeScore: number;
  }

  const computeExplodeTargets = (axis: "x" | "y" | "z") => {
    explodeOriginals.clear();
    explodeDirections.clear();

    const modelBoundingBox = ctx.getModelBoundingBox();
    if (!ctx.loadedModel.value || !ctx.scene.value || !modelBoundingBox) return;

    ctx.scene.value.updateMatrixWorld(true);

    const selectedIds = ctx.getSelectedNodeIds();
    let targets: THREE.Object3D[];

    if (selectedIds.length > 0) {
      const sel = ctx.scene.value.getObjectById(selectedIds[0]);
      const parent = sel?.parent;
      targets = (parent?.children ?? []).filter(ctx.isSignificantChild);
    } else {
      let container: THREE.Object3D = ctx.loadedModel.value;
      let significant = container.children.filter(ctx.isSignificantChild);
      while (significant.length === 1) {
        container = significant[0];
        significant = container.children.filter(ctx.isSignificantChild);
      }
      targets = significant;
    }

    if (targets.length < 2) return;

    const parent = targets[0].parent!;

    const worldOrigin = modelBoundingBox.getCenter(new THREE.Vector3());

    const worldAxis = new THREE.Vector3(
      axis === "x" ? 1 : 0,
      axis === "y" ? 1 : 0,
      axis === "z" ? 1 : 0,
    );
    const invQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(invQuat).invert();
    const localAxis = worldAxis.applyQuaternion(invQuat);

    explodeScaleFactor = 0.5;
    currentExplodeAxis = axis;

    const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    const originCoord = worldOrigin.getComponent(axisIdx);

    const entries: ExplodeEntry[] = [];
    for (const t of targets) {
      explodeOriginals.set(t, t.position.clone());

      const nodeBox = getVisibleBBox(t);
      if (nodeBox.isEmpty()) continue;

      const centerCoord = nodeBox
        .getCenter(new THREE.Vector3())
        .getComponent(axisIdx);
      const centerDist = centerCoord - originCoord;
      const faceMin = nodeBox.min.getComponent(axisIdx);
      const faceMax = nodeBox.max.getComponent(axisIdx);

      const sign: 1 | -1 = centerDist >= 0 ? 1 : -1;
      const faceDist = Math.abs(
        sign === 1 ? faceMax - originCoord : faceMin - originCoord,
      );
      const absCenterDist = Math.abs(centerDist);
      const compositeScore = 0.8 * faceDist + 0.2 * absCenterDist;

      entries.push({
        target: t,
        sign,
        axMin: faceMin,
        axMax: faceMax,
        compositeScore,
      });
    }

    const posSide = entries
      .filter((e) => e.sign === 1)
      .sort((a, b) => a.compositeScore - b.compositeScore);
    const negSide = entries
      .filter((e) => e.sign === -1)
      .sort((a, b) => a.compositeScore - b.compositeScore);

    const modelSize = modelBoundingBox
      .getSize(new THREE.Vector3())
      .getComponent(axisIdx);
    const step = modelSize * 0.01;

    const assignRanksAndDirections = (
      side: ExplodeEntry[],
      dirSign: 1 | -1,
    ) => {
      if (side.length === 0) return;

      const maxScore = side[side.length - 1].compositeScore || 1;

      let rank = 1;
      let rankMin = side[0].axMin;
      let rankMax = side[0].axMax;

      for (const entry of side) {
        const overlaps = entry.axMin < rankMax && entry.axMax > rankMin;
        if (overlaps) {
          rank++;
          rankMin = entry.axMin;
          rankMax = entry.axMax;
        } else {
          rankMin = Math.min(rankMin, entry.axMin);
          rankMax = Math.max(rankMax, entry.axMax);
        }

        const bonus = step * 0.3 * (entry.compositeScore / maxScore);
        const magnitude = step * rank + bonus;
        const dir = localAxis.clone().multiplyScalar(dirSign * magnitude);
        explodeDirections.set(entry.target, dir);
      }
    };

    assignRanksAndDirections(posSide, 1);
    assignRanksAndDirections(negSide, -1);
  };

  const resetExplode = () => {
    for (const [obj, orig] of explodeOriginals) obj.position.copy(orig);
    explodeOriginals.clear();
    explodeDirections.clear();
    explodeMagnitude = 0;
    ctx.updateClippingFromBounds();
    ctx.refreshSectionCaps();
  };

  const onExplodeChange = (
    explodeValue: Ref<number>,
    axis: "x" | "y" | "z" = "x",
  ) => {
    const val = explodeValue.value;

    if (val <= 0) {
      if (explodeMagnitude > 0) resetExplode();
      return;
    }

    if (explodeOriginals.size === 0 || axis !== currentExplodeAxis) {
      resetExplode();
      computeExplodeTargets(axis);
    }

    for (const [obj, dir] of explodeDirections) {
      const orig = explodeOriginals.get(obj)!;
      obj.position.copy(orig).addScaledVector(dir, val * explodeScaleFactor);
    }
    explodeMagnitude = val;
    ctx.updateClippingFromBounds();
    ctx.refreshSectionCaps();
  };

  const getExplodeMagnitude = (): number => explodeMagnitude;

  return {
    onExplodeChange,
    getExplodeMagnitude,
    resetExplode,
    showDebugBBoxes,
    clearDebugBBoxes,
  };
}
