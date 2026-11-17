import { ref, type ShallowRef } from "vue";
import * as THREE from "three";

export interface PartSelectionContext {
  loadedModel: ShallowRef<THREE.Group | null>;
  scene: ShallowRef<THREE.Scene | null>;
  detachTransformGizmo: () => void;
  refreshAllCaps: () => void;
  collectInstanceMeshes: (node: THREE.Object3D) => THREE.Mesh[];
  setMeshVisibility: (child: THREE.Object3D, visible: boolean) => void;
}

interface SelectionEntry {
  node: THREE.Object3D;
  outlines: THREE.Mesh[];
  overlays: THREE.Mesh[];
}

export function usePartSelection(ctx: PartSelectionContext) {
  // ── Selection state ──────────────────────────────────────────────────

  const selectionMap = new Map<number, SelectionEntry>();
  const selectedNodeIdsRef = ref<number[]>([]);
  let hoveredInstanceNode: THREE.Object3D | null = null;
  let selectedInstanceNode: THREE.Object3D | null = null;
  let hoverOutlineHelpers: THREE.Mesh[] = [];

  // ── Materials ────────────────────────────────────────────────────────

  const selectionOverlayMat = new THREE.MeshBasicMaterial({
    color: 0x10bbde,
    transparent: true,
    opacity: 0.5,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const OUTLINE_STENCIL_REF = 1;

  const stencilWriterMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  stencilWriterMat.stencilWrite = true;
  stencilWriterMat.stencilRef = OUTLINE_STENCIL_REF;
  stencilWriterMat.stencilFunc = THREE.AlwaysStencilFunc;
  stencilWriterMat.stencilZPass = THREE.ReplaceStencilOp;
  stencilWriterMat.stencilZFail = THREE.ReplaceStencilOp;
  stencilWriterMat.stencilFail = THREE.ReplaceStencilOp;

  const createOutlineMaterial = (
    color: THREE.Color,
    thicknessPx: number,
  ): THREE.ShaderMaterial => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        outlineColor: { value: color },
        outlineThickness: { value: thicknessPx },
        screenSize: { value: new THREE.Vector2(1, 1) },
      },
      // The clipping chunks make the outline obey the section planes (otherwise it is drawn over the cut-away part).
      vertexShader: /* glsl */ `
        #include <clipping_planes_pars_vertex>
        uniform float outlineThickness;
        uniform vec2  screenSize;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vec4 clipPos  = projectionMatrix * mvPosition;
          vec4 clipNorm = projectionMatrix * modelViewMatrix * vec4(position + normal, 1.0);
          vec2 ndcPos  = clipPos.xy  / clipPos.w;
          vec2 ndcNorm = clipNorm.xy / clipNorm.w;
          vec2 dir = normalize(ndcNorm - ndcPos);
          vec2 offset = dir * outlineThickness * 2.0 / screenSize;
          gl_Position = clipPos;
          gl_Position.xy += offset * clipPos.w;
          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <clipping_planes_pars_fragment>
        uniform vec3 outlineColor;
        void main() {
          #include <clipping_planes_fragment>
          gl_FragColor = vec4(outlineColor, 1.0);
        }
      `,
      clipping: true,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    mat.stencilWrite = true;
    mat.stencilFunc = THREE.NotEqualStencilFunc;
    mat.stencilRef = OUTLINE_STENCIL_REF;
    mat.stencilFail = THREE.KeepStencilOp;
    mat.stencilZFail = THREE.KeepStencilOp;
    mat.stencilZPass = THREE.KeepStencilOp;
    return mat;
  };

  const hoverOutlineMat = createOutlineMaterial(new THREE.Color(0xffffff), 2.0);
  const selectOutlineMat = createOutlineMaterial(
    new THREE.Color(0x3bdeff),
    3.0,
  );

  // ── Internal helpers ─────────────────────────────────────────────────

  const applySelectionOverlay = (
    instanceNode: THREE.Object3D,
  ): THREE.Mesh[] => {
    const meshes = ctx.collectInstanceMeshes(instanceNode);
    const overlays: THREE.Mesh[] = [];
    for (const mesh of meshes) {
      const overlay = new THREE.Mesh(mesh.geometry, selectionOverlayMat);
      overlay.userData._isOutlineHelper = true;
      overlay.raycast = () => {};
      overlay.frustumCulled = mesh.frustumCulled;
      overlay.renderOrder = 100;
      mesh.add(overlay);
      overlays.push(overlay);
    }
    return overlays;
  };

  const removeOverlayMeshes = (overlays: THREE.Mesh[]) => {
    for (const mesh of overlays) {
      if (mesh.parent) mesh.parent.remove(mesh);
    }
    overlays.length = 0;
  };

  const addOutlineMeshes = (
    instanceNode: THREE.Object3D,
    material: THREE.ShaderMaterial,
  ): THREE.Mesh[] => {
    const sourceMeshes = ctx.collectInstanceMeshes(instanceNode);
    const helpers: THREE.Mesh[] = [];
    for (const mesh of sourceMeshes) {
      const writer = new THREE.Mesh(mesh.geometry, stencilWriterMat);
      writer.userData._isOutlineHelper = true;
      writer.raycast = () => {};
      writer.frustumCulled = mesh.frustumCulled;
      writer.renderOrder = 9998;
      mesh.add(writer);
      helpers.push(writer);

      const outline = new THREE.Mesh(mesh.geometry, material);
      outline.userData._isOutlineHelper = true;
      outline.raycast = () => {};
      outline.frustumCulled = mesh.frustumCulled;
      outline.renderOrder = 9999;
      mesh.add(outline);
      helpers.push(outline);
    }
    return helpers;
  };

  const removeOutlineMeshes = (helpers: THREE.Mesh[]) => {
    for (const h of helpers) {
      if (h.parent) h.parent.remove(h);
    }
    helpers.length = 0;
  };

  const syncSelectedIds = () => {
    selectedNodeIdsRef.value = [...selectionMap.keys()];
  };

  // ── Public API ───────────────────────────────────────────────────────

  const addToSelection = (node: THREE.Object3D) => {
    if (selectionMap.has(node.id)) return;
    const outlines = addOutlineMeshes(node, selectOutlineMat);
    const overlays = applySelectionOverlay(node);
    selectionMap.set(node.id, { node, outlines, overlays });
    syncSelectedIds();
  };

  const removeFromSelection = (nodeId: number) => {
    const entry = selectionMap.get(nodeId);
    if (!entry) return;
    removeOutlineMeshes(entry.outlines);
    removeOverlayMeshes(entry.overlays);
    selectionMap.delete(nodeId);

    if (selectedInstanceNode?.id === nodeId) {
      ctx.detachTransformGizmo();
      const remaining = selectionMap.values().next().value as
        | SelectionEntry
        | undefined;
      selectedInstanceNode = remaining?.node ?? null;
    }
    syncSelectedIds();
  };

  const clearAllSelections = () => {
    for (const entry of selectionMap.values()) {
      removeOutlineMeshes(entry.outlines);
      removeOverlayMeshes(entry.overlays);
    }
    selectionMap.clear();
    selectedInstanceNode = null;
    syncSelectedIds();
  };

  const clearSelectionHighlight = () => {
    ctx.detachTransformGizmo();
    clearAllSelections();
  };

  const selectNode = (nodeId: number) => {
    if (!ctx.scene.value) return;
    clearSelectionHighlight();
    const obj = ctx.scene.value.getObjectById(nodeId);
    if (!obj) return;
    addToSelection(obj);
    selectedInstanceNode = obj;
    if (hoveredInstanceNode === obj) {
      removeOutlineMeshes(hoverOutlineHelpers);
    }
  };

  // ── Hover ────────────────────────────────────────────────────────────

  const setHover = (instanceNode: THREE.Object3D | null) => {
    if (!instanceNode) {
      clearHover();
      return;
    }
    if (instanceNode === hoveredInstanceNode) return;
    removeOutlineMeshes(hoverOutlineHelpers);
    hoveredInstanceNode = instanceNode;
    if (!selectionMap.has(instanceNode.id)) {
      hoverOutlineHelpers = addOutlineMeshes(instanceNode, hoverOutlineMat);
    }
  };

  const clearHover = () => {
    if (hoveredInstanceNode) {
      removeOutlineMeshes(hoverOutlineHelpers);
      hoveredInstanceNode = null;
    }
  };

  // ── Visibility actions ───────────────────────────────────────────────

  const hideSelectedNodes = () => {
    if (selectionMap.size === 0) return;
    for (const { node } of selectionMap.values()) {
      node.traverse((child) => ctx.setMeshVisibility(child, false));
    }
    clearSelectionHighlight();
    ctx.refreshAllCaps();
  };

  const isolateSelectedNodes = () => {
    if (selectionMap.size === 0 || !ctx.loadedModel.value) return;
    const entries = [...selectionMap.values()];
    ctx.loadedModel.value.traverse((child) =>
      ctx.setMeshVisibility(child, false),
    );
    for (const { node } of entries) {
      node.traverse((child) => ctx.setMeshVisibility(child, true));
    }
    ctx.refreshAllCaps();
  };

  // ── Getters / setters ────────────────────────────────────────────────

  const getSelectedInstanceNode = (): THREE.Object3D | null =>
    selectedInstanceNode;
  const setSelectedInstanceNode = (node: THREE.Object3D | null) => {
    selectedInstanceNode = node;
  };
  const getHoveredNode = (): THREE.Object3D | null => hoveredInstanceNode;
  const isSelected = (nodeId: number): boolean => selectionMap.has(nodeId);
  const getSelectedNodeIds = (): number[] => selectedNodeIdsRef.value;
  const getSelectedNodes = (): THREE.Object3D[] =>
    [...selectionMap.values()].map((e) => e.node);

  // ── Rendering ────────────────────────────────────────────────────────

  const updateScreenSize = (size: THREE.Vector2) => {
    hoverOutlineMat.uniforms.screenSize.value.copy(size);
    selectOutlineMat.uniforms.screenSize.value.copy(size);
  };

  // ── Cleanup ──────────────────────────────────────────────────────────

  const dispose = () => {
    removeOutlineMeshes(hoverOutlineHelpers);
    clearAllSelections();
    hoveredInstanceNode = null;
    stencilWriterMat.dispose();
    selectionOverlayMat.dispose();
    hoverOutlineMat.dispose();
    selectOutlineMat.dispose();
  };

  return {
    /** Materials that must be cut by the section planes like the model (outline, overlay, stencil). */
    clippableMaterials: [
      selectionOverlayMat,
      stencilWriterMat,
      hoverOutlineMat,
      selectOutlineMat,
    ] as THREE.Material[],
    addToSelection,
    removeFromSelection,
    clearAllSelections,
    clearSelectionHighlight,
    selectNode,
    setHover,
    clearHover,
    hideSelectedNodes,
    isolateSelectedNodes,
    getSelectedInstanceNode,
    setSelectedInstanceNode,
    getHoveredNode,
    isSelected,
    getSelectedNodeIds,
    getSelectedNodes,
    selectedNodeIdsRef,
    updateScreenSize,
    dispose,
  };
}
