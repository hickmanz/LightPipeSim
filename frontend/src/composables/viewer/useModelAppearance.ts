import { type Ref, type ShallowRef, type Component } from "vue";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { drawModes } from "./viewerConstants";

export interface ModelAppearanceContext {
  loadedModel: ShallowRef<THREE.Group | null>;
  updateMaterialClipping: () => void;
  refreshAllCaps: () => void;
  getHiddenNodeIds: () => string[];
  findNodeByInstanceId: (id: string) => THREE.Object3D | null;
  collectInstanceMeshes: (node: THREE.Object3D) => THREE.Mesh[];
  setMeshVisibility: (child: THREE.Object3D, visible: boolean) => void;
  getSelectedInstanceNodes: () => THREE.Object3D[];
  findParentInstanceNode: (obj: THREE.Object3D) => THREE.Object3D | null;
}

type DrawModeEntry = {
  id: string;
  label: string;
  icon: Component;
  mode: number;
};

export function useModelAppearance(ctx: ModelAppearanceContext) {
  // ── Material state maps ──────────────────────────────────────────────

  const originalMaterialState = new WeakMap<
    THREE.Material,
    {
      transparent: boolean;
      opacity: number;
      depthWrite: boolean;
      colorWrite: boolean;
      polygonOffset: boolean;
      polygonOffsetFactor: number;
      polygonOffsetUnits: number;
    }
  >();

  let hiddenEdgeClones: THREE.Object3D[] = [];
  const xrayMeshOriginals = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >();
  const originalEdgeMaterials = new Map<
    number,
    THREE.Material | THREE.Material[]
  >();

  const xrayShaderMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(0.15, 0.65, 0.85) },
      uEdgePower: { value: 2.0 },
      uBaseAlpha: { value: 0.15 },
    },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor;
      uniform float uEdgePower;
      uniform float uBaseAlpha;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        #include <clipping_planes_fragment>
        float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float rim = pow(1.0 - facing, uEdgePower);
        float alpha = uBaseAlpha + rim * (1.0 - uBaseAlpha);
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    clipping: true,
  });

  const transparencyMeshOriginals = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >();
  const highlightDimmedMeshOriginals = new Map<
    THREE.Mesh,
    THREE.Material | THREE.Material[]
  >();

  let cachedMaterials: THREE.Material[] = [];

  let _activeDrawModeId = "wireframeOnShaded";
  let _drawModeRef: Ref<DrawModeEntry | null> | null = null;

  // ── Shared internal helpers ──────────────────────────────────────────

  /**
   * Clone a mesh's material(s) and apply a target opacity.
   * Handles both single and multi-material meshes.
   */
  const applyTransparentClone = (mesh: THREE.Mesh, opacity: number) => {
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = opacity;
        c.depthWrite = false;
        c.needsUpdate = true;
        return c;
      });
    } else {
      const c = (mesh.material as THREE.Material).clone();
      (c as any).transparent = true;
      (c as any).opacity = opacity;
      c.depthWrite = false;
      c.needsUpdate = true;
      mesh.material = c;
    }
  };

  /**
   * Create the hidden-line edge clone (occluded-edge visualization) for a
   * fat-line edge node. Returns the clone that the caller should add to
   * the parent.
   */
  const createHiddenEdgeClone = (
    fatLine: LineSegments2,
    activeClipping: THREE.Plane[] | null,
  ): LineSegments2 => {
    const hiddenClone = new LineSegments2(
      fatLine.geometry as LineSegmentsGeometry,
      new LineMaterial({
        color: 0x1a1a1a,
        linewidth: 1,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        depthTest: true,
        clippingPlanes: activeClipping,
      }),
    );
    (hiddenClone.material as LineMaterial).resolution.set(
      window.innerWidth,
      window.innerHeight,
    );
    (hiddenClone.material as LineMaterial).depthFunc = THREE.GreaterDepth;
    hiddenClone.position.copy(fatLine.position);
    hiddenClone.rotation.copy(fatLine.rotation);
    hiddenClone.scale.copy(fatLine.scale);
    hiddenClone.matrix.copy(fatLine.matrix);
    hiddenClone.matrixAutoUpdate = fatLine.matrixAutoUpdate;
    hiddenClone.frustumCulled = false;
    hiddenClone.renderOrder = 1;
    hiddenClone.userData = { ...fatLine.userData, isHiddenEdgeClone: true };
    hiddenClone.raycast = () => {};
    cachedMaterials.push(hiddenClone.material as LineMaterial);
    return hiddenClone;
  };

  /**
   * Apply draw-mode baseline reset + mode-specific override to a single
   * scene-graph node. Shared by both applyDrawMode (full traverse) and
   * applyFeedbackDrawMode (optimised walk that skips hidden subtrees).
   */
  const applyDrawModeToNode = (node: THREE.Object3D, modeId: string) => {
    if (node.userData?.isFatEdgeLine) {
      // Baseline reset
      node.visible = true;
      node.renderOrder = 1;

      // Mode override
      if (modeId === "shaded") {
        node.visible = false;
      } else if (modeId === "xray") {
        node.renderOrder = 2;
        const fatLine = node as LineSegments2;
        const origMat = fatLine.material as LineMaterial;
        const activeClipping = origMat.clippingPlanes ?? null;
        originalEdgeMaterials.set(node.id, origMat);
        const edgeMat = new LineMaterial({
          color: 0x88ccee,
          linewidth: 1,
          transparent: true,
          opacity: 0.15,
          depthWrite: false,
          depthTest: false,
          clippingPlanes: activeClipping,
        });
        edgeMat.resolution.set(window.innerWidth, window.innerHeight);
        fatLine.material = edgeMat;
        cachedMaterials.push(edgeMat);
      } else if (modeId === "hiddenLine") {
        node.renderOrder = 2;
        const fatLine = node as LineSegments2;
        const origMat = fatLine.material as LineMaterial;
        const activeClipping = origMat.clippingPlanes ?? null;
        originalEdgeMaterials.set(node.id, origMat);
        const visibleMat = new LineMaterial({
          color: 0xcccccc,
          linewidth: 1,
          transparent: true,
          opacity: 1.0,
          depthWrite: false,
          depthTest: true,
          clippingPlanes: activeClipping,
        });
        visibleMat.resolution.set(window.innerWidth, window.innerHeight);
        fatLine.material = visibleMat;
        cachedMaterials.push(visibleMat);

        const hiddenClone = createHiddenEdgeClone(fatLine, activeClipping);
        if (node.parent) node.parent.add(hiddenClone);
        hiddenEdgeClones.push(hiddenClone);
      }
    } else if (node instanceof THREE.Mesh && !node.userData?._isOutlineHelper) {
      // Baseline reset
      node.visible = true;
      const mats = Array.isArray(node.material)
        ? node.material
        : [node.material];
      for (const mat of mats) {
        const orig = originalMaterialState.get(mat);
        if (orig) {
          mat.transparent = orig.transparent;
          mat.opacity = orig.opacity;
          mat.depthWrite = orig.depthWrite;
          mat.colorWrite = orig.colorWrite;
          mat.polygonOffset = orig.polygonOffset;
          mat.polygonOffsetFactor = orig.polygonOffsetFactor;
          mat.polygonOffsetUnits = orig.polygonOffsetUnits;
        }
        mat.needsUpdate = true;
      }

      // Mode override
      if (modeId === "wireframe") {
        node.visible = false;
      } else if (modeId === "xray") {
        xrayMeshOriginals.set(node, node.material);
        node.material = xrayShaderMat;
      } else if (modeId === "hiddenLine") {
        for (const mat of mats) {
          mat.colorWrite = false;
          mat.depthWrite = true;
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = 1;
          mat.polygonOffsetUnits = 1;
          mat.needsUpdate = true;
        }
      }
    }
  };

  // ── removeHiddenEdgeClones ───────────────────────────────────────────

  const removeHiddenEdgeClones = () => {
    for (const [mesh, orig] of xrayMeshOriginals) {
      mesh.material = orig;
    }
    xrayMeshOriginals.clear();

    const disposedMats = new Set<THREE.Material>();

    for (const clone of hiddenEdgeClones) {
      clone.parent?.remove(clone);
      if ((clone as any).material) {
        disposedMats.add((clone as any).material);
        (clone as any).material.dispose();
      }
    }
    hiddenEdgeClones = [];

    if (originalEdgeMaterials.size > 0 && ctx.loadedModel.value) {
      ctx.loadedModel.value.traverse((child: THREE.Object3D) => {
        if (
          child.userData.isFatEdgeLine &&
          originalEdgeMaterials.has(child.id)
        ) {
          if ((child as any).material) {
            disposedMats.add((child as any).material);
            (child as any).material.dispose();
          }
          (child as any).material = originalEdgeMaterials.get(child.id);
        }
      });
      originalEdgeMaterials.clear();
    }

    if (disposedMats.size > 0) {
      cachedMaterials = cachedMaterials.filter((m) => !disposedMats.has(m));
    }
  };

  // ── Public methods ───────────────────────────────────────────────────

  const applyDrawMode = (
    id: string,
    currentDrawMode: Ref<DrawModeEntry | null>,
  ) => {
    _activeDrawModeId = id;
    _drawModeRef = currentDrawMode;
    if (!ctx.loadedModel.value) return;

    const hiddenIds = ctx.getHiddenNodeIds();

    // Save and undo per-mesh transparency / highlight clones so
    // the baseline reset operates on original (tracked) materials.
    const savedTransparent: { mesh: THREE.Mesh; opacity: number }[] = [];
    for (const [mesh] of transparencyMeshOriginals) {
      const mat = Array.isArray(mesh.material)
        ? mesh.material[0]
        : mesh.material;
      savedTransparent.push({ mesh, opacity: (mat as any).opacity ?? 1 });
    }
    for (const [mesh, orig] of transparencyMeshOriginals) {
      mesh.material = orig;
    }
    transparencyMeshOriginals.clear();

    const savedHighlight: { mesh: THREE.Mesh; opacity: number }[] = [];
    for (const [mesh] of highlightDimmedMeshOriginals) {
      const mat = Array.isArray(mesh.material)
        ? mesh.material[0]
        : mesh.material;
      savedHighlight.push({ mesh, opacity: (mat as any).opacity ?? 1 });
    }
    for (const [mesh, orig] of highlightDimmedMeshOriginals) {
      mesh.material = orig;
    }
    highlightDimmedMeshOriginals.clear();

    removeHiddenEdgeClones();

    // Apply baseline reset + mode override in a single traversal
    ctx.loadedModel.value.traverse((child) => applyDrawModeToNode(child, id));

    if (id === "xray") cachedMaterials.push(xrayShaderMat);

    // Re-apply transparency/highlight clones on top of the new baseline
    for (const { mesh, opacity } of savedTransparent) {
      transparencyMeshOriginals.set(mesh, mesh.material);
      applyTransparentClone(mesh, opacity);
    }
    for (const { mesh, opacity } of savedHighlight) {
      highlightDimmedMeshOriginals.set(mesh, mesh.material);
      applyTransparentClone(mesh, opacity);
    }

    // Re-hide previously hidden nodes
    if (hiddenIds.length > 0) {
      for (const iid of hiddenIds) {
        const obj = ctx.findNodeByInstanceId(iid);
        if (obj) {
          obj.traverse((child) => ctx.setMeshVisibility(child, false));
        }
      }
    }

    ctx.updateMaterialClipping();
    ctx.refreshAllCaps();

    const found = drawModes.find((m) => m.id === id);
    if (found) currentDrawMode.value = found;
  };

  const reapplyDrawMode = () => {
    if (_drawModeRef) {
      applyDrawMode(_activeDrawModeId, _drawModeRef);
    }
  };

  const getActiveDrawModeId = () => _activeDrawModeId;

  /**
   * Material-only portion of feedback model-state restore.
   * Applies draw-mode baseline + transparency overlay in a single
   * optimised walk that skips hidden subtrees.
   *
   * Does NOT call refreshAllCaps — the caller handles that.
   */
  const applyFeedbackDrawMode = (opts: {
    drawModeId: string;
    hiddenIds: Set<string>;
    transparentNodes: Map<string, number>;
  }) => {
    if (!ctx.loadedModel.value) return;

    for (const [mesh, orig] of transparencyMeshOriginals) mesh.material = orig;
    transparencyMeshOriginals.clear();
    for (const [mesh, orig] of highlightDimmedMeshOriginals)
      mesh.material = orig;
    highlightDimmedMeshOriginals.clear();
    removeHiddenEdgeClones();

    const modeId = opts.drawModeId;

    const walkNode = (node: THREE.Object3D) => {
      const iid = node.userData?.cadreview_instanceId;

      if (iid && opts.hiddenIds.has(iid)) {
        node.traverse((c) => ctx.setMeshVisibility(c, false));
        return;
      }

      applyDrawModeToNode(node, modeId);

      if (iid && opts.transparentNodes.has(iid)) {
        const opacity = opts.transparentNodes.get(iid)!;
        const meshes = ctx.collectInstanceMeshes(node);
        for (const mesh of meshes) {
          transparencyMeshOriginals.set(mesh, mesh.material);
          applyTransparentClone(mesh, opacity);
        }
      }

      for (const child of node.children) {
        walkNode(child);
      }
    };
    walkNode(ctx.loadedModel.value);

    if (xrayMeshOriginals.size > 0) cachedMaterials.push(xrayShaderMat);

    ctx.updateMaterialClipping();
  };

  const toggleTransparency = (opacityPercent: number = 60) => {
    const selectedNodes = ctx.getSelectedInstanceNodes();
    if (selectedNodes.length === 0) return;

    for (const node of selectedNodes) {
      const meshes = ctx.collectInstanceMeshes(node);
      const anyInMap = meshes.some((m) => transparencyMeshOriginals.has(m));

      if (anyInMap) {
        for (const mesh of meshes) {
          const orig = transparencyMeshOriginals.get(mesh);
          if (orig) {
            mesh.material = orig;
            transparencyMeshOriginals.delete(mesh);
          }
        }
      } else {
        const targetOpacity = opacityPercent / 100;
        for (const mesh of meshes) {
          transparencyMeshOriginals.set(mesh, mesh.material);
          applyTransparentClone(mesh, targetOpacity);
        }
      }
    }
    ctx.updateMaterialClipping();
  };

  const updateTransparencyOpacity = (opacityPercent: number) => {
    if (transparencyMeshOriginals.size === 0) return;
    const targetOpacity = opacityPercent / 100;
    for (const [mesh] of transparencyMeshOriginals) {
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) {
          m.opacity = targetOpacity;
          m.needsUpdate = true;
        }
      } else {
        mesh.material.opacity = targetOpacity;
        mesh.material.needsUpdate = true;
      }
    }
  };

  const highlightSelectedNodes = () => {
    if (!ctx.loadedModel.value) return;

    if (highlightDimmedMeshOriginals.size > 0) {
      for (const [mesh, orig] of highlightDimmedMeshOriginals) {
        mesh.material = orig;
      }
      highlightDimmedMeshOriginals.clear();
      return;
    }

    const selectedNodes = ctx.getSelectedInstanceNodes();
    if (selectedNodes.length === 0) return;
    const selectedIds = new Set(selectedNodes.map((n) => n.id));

    ctx.loadedModel.value.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData?._isOutlineHelper) return;
      if (child.userData?.isFatEdgeLine) return;

      let isUnderSelected = false;
      let cur: THREE.Object3D | null = child;
      while (cur) {
        if (selectedIds.has(cur.id)) {
          isUnderSelected = true;
          break;
        }
        cur = cur.parent;
      }
      if (isUnderSelected) return;

      highlightDimmedMeshOriginals.set(child, child.material);
      applyTransparentClone(child, 0.3);
    });
    ctx.updateMaterialClipping();
  };

  /**
   * Return per-node transparency data using stable instance IDs.
   * Captures both per-part transparency and highlight-dim state.
   */
  const getTransparentNodes = (): { instanceId: string; opacity: number }[] => {
    if (
      transparencyMeshOriginals.size === 0 &&
      highlightDimmedMeshOriginals.size === 0
    )
      return [];
    const result: { instanceId: string; opacity: number }[] = [];
    const visited = new Set<string>();

    for (const [mesh] of transparencyMeshOriginals) {
      const instanceNode = ctx.findParentInstanceNode(mesh);
      const iid = instanceNode?.userData?.cadreview_instanceId;
      if (iid && !visited.has(iid)) {
        visited.add(iid);
        const mat = Array.isArray(mesh.material)
          ? mesh.material[0]
          : mesh.material;
        result.push({ instanceId: iid, opacity: mat.opacity });
      }
    }

    for (const [mesh] of highlightDimmedMeshOriginals) {
      const instanceNode = ctx.findParentInstanceNode(mesh);
      const iid = instanceNode?.userData?.cadreview_instanceId;
      if (iid && !visited.has(iid)) {
        visited.add(iid);
        const mat = Array.isArray(mesh.material)
          ? mesh.material[0]
          : mesh.material;
        result.push({ instanceId: iid, opacity: mat.opacity });
      }
    }

    return result;
  };

  /**
   * Restore transparent nodes from saved markup data (stable instance IDs).
   */
  const restoreTransparentNodes = (
    nodes: { instanceId: string; opacity: number }[],
  ) => {
    for (const [mesh, orig] of transparencyMeshOriginals) {
      mesh.material = orig;
    }
    transparencyMeshOriginals.clear();

    for (const [mesh, orig] of highlightDimmedMeshOriginals) {
      mesh.material = orig;
    }
    highlightDimmedMeshOriginals.clear();

    for (const { instanceId, opacity } of nodes) {
      const obj = ctx.findNodeByInstanceId(instanceId);
      if (!obj) continue;
      const meshes = ctx.collectInstanceMeshes(obj);
      for (const mesh of meshes) {
        transparencyMeshOriginals.set(mesh, mesh.material);
        applyTransparentClone(mesh, opacity);
      }
    }
    ctx.updateMaterialClipping();
  };

  /**
   * Clear transparency + highlight material overrides, restoring
   * original shared materials. Called by the hub's resetModel.
   */
  const resetMaterialOverrides = () => {
    for (const [mesh, orig] of transparencyMeshOriginals) {
      mesh.material = orig;
    }
    transparencyMeshOriginals.clear();

    for (const [mesh, orig] of highlightDimmedMeshOriginals) {
      mesh.material = orig;
    }
    highlightDimmedMeshOriginals.clear();
  };

  /**
   * Register a material's original property snapshot during model load.
   * Called by the hub for every mesh material encountered in the
   * GLB traversal so that draw-mode switches can restore the baseline.
   */
  const registerOriginalMaterialState = (mat: THREE.Material) => {
    if (!originalMaterialState.has(mat)) {
      originalMaterialState.set(mat, {
        transparent: mat.transparent,
        opacity: mat.opacity,
        depthWrite: mat.depthWrite,
        colorWrite: mat.colorWrite,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
      });
    }
  };

  const getCachedMaterials = (): THREE.Material[] => cachedMaterials;

  /**
   * Replace the cached materials list (called by the hub after BVH setup
   * to initialize the cache with all model materials).
   */
  const initCachedMaterials = (mats: THREE.Material[]) => {
    cachedMaterials = mats;
  };

  /**
   * Reset model-load-specific state. Called by the hub before loading
   * a new model (clears cached materials, hidden-edge clones, etc.).
   */
  const resetForModelLoad = () => {
    removeHiddenEdgeClones();
    cachedMaterials = [];
    transparencyMeshOriginals.clear();
    highlightDimmedMeshOriginals.clear();
  };

  /**
   * Dispose all owned Three.js materials and clear internal state.
   */
  const dispose = () => {
    xrayShaderMat.dispose();
    removeHiddenEdgeClones();
    cachedMaterials = [];
    transparencyMeshOriginals.clear();
    highlightDimmedMeshOriginals.clear();
  };

  return {
    applyDrawMode,
    reapplyDrawMode,
    getActiveDrawModeId,
    applyFeedbackDrawMode,
    toggleTransparency,
    updateTransparencyOpacity,
    highlightSelectedNodes,
    getTransparentNodes,
    restoreTransparentNodes,
    resetMaterialOverrides,
    registerOriginalMaterialState,
    getCachedMaterials,
    initCachedMaterials,
    resetForModelLoad,
    dispose,
  };
}
