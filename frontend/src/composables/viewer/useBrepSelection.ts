/**
 * useBrepSelection.ts
 *
 * Shared composable for BREP entity hover/selection highlighting.
 * Resolves raycast hits into typed BREP entities (face, edge, point)
 * and manages transient highlight overlays in the scene. Used by
 * useThreeMeasure and available for future tools that need entity picking.
 */
import { type ShallowRef } from "vue";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { BrepEdge, BrepEdgeHit, BrepFace } from "./useBrepTopology";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrepHitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  object: THREE.Object3D;
  faceIndex: number | null;
}

export type BrepEntity =
  | {
      kind: "edge";
      instanceNode: THREE.Object3D;
      edgeId: number;
      edge: BrepEdge;
      closestPoint: THREE.Vector3;
      hitFaceNormal: THREE.Vector3;
    }
  | {
      kind: "face";
      mesh: THREE.Mesh;
      faceId: number;
      normal: THREE.Vector3;
      hitPoint: THREE.Vector3;
    }
  | {
      kind: "point";
      instanceNode: THREE.Object3D;
      worldPoint: THREE.Vector3;
      hitFaceNormal?: THREE.Vector3;
    };

export interface BrepSelectionContext {
  scene: ShallowRef<THREE.Scene | null>;
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  renderer: ShallowRef<THREE.WebGLRenderer | null>;
  getHitInfo: (event: MouseEvent | PointerEvent) => BrepHitInfo | null;
  findParentInstanceNode?: (obj: THREE.Object3D) => THREE.Object3D | null;
  getFaceIdAtTriangle?: (mesh: THREE.Mesh, faceIndex: number) => number | null;
  getBrepFaceData?: (mesh: THREE.Mesh, faceId: number) => BrepFace | null;
  getBrepFaceTrianglePositions?: (
    mesh: THREE.Mesh,
    faceId: number,
  ) => Float32Array | null;
  findNearestBrepEdge?: (
    instanceNode: THREE.Object3D,
    worldPoint: THREE.Vector3,
  ) => BrepEdgeHit | null;
  getBrepEdgeWorldPositions?: (
    instanceNode: THREE.Object3D,
    edgeId: number,
  ) => [THREE.Vector3, THREE.Vector3][] | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HIGHLIGHT_COLOR = 0x3b82f6;
export const POINT_HIGHLIGHT_COLOR = 0x3b82f6;
export const EDGE_SNAP_PX = 12;
export const POINT_SNAP_PX = 8;
const HOVER_THROTTLE_MS = 50;
const POINT_HIGHLIGHT_SCREEN_PX = 12.8; // ~MARKER_SCREEN_PX(8) * 1.6

// ---------------------------------------------------------------------------
// Shared geometry (reused across all sphere markers)
// ---------------------------------------------------------------------------

let _sphereGeo: THREE.SphereGeometry | null = null;
export const getSphereGeo = (): THREE.SphereGeometry => {
  if (!_sphereGeo) _sphereGeo = new THREE.SphereGeometry(0.5, 16, 16);
  return _sphereGeo;
};

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useBrepSelection(context: BrepSelectionContext) {
  let currentHighlightObjects: THREE.Object3D[] = [];
  let currentHighlightKey = "";
  let lastHoverTime = 0;

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const worldPerPixel = (distance: number): number => {
    const cam = context.camera.value;
    if (!cam) return 0.001;
    const rend = context.renderer.value;
    const height = rend?.domElement.clientHeight ?? 800;
    if (cam instanceof THREE.PerspectiveCamera) {
      const vFov = THREE.MathUtils.degToRad(cam.fov);
      return (2 * distance * Math.tan(vFov / 2)) / height;
    }
    const ortho = cam as THREE.OrthographicCamera;
    return (ortho.top - ortho.bottom) / ortho.zoom / height;
  };

  const getRendererResolution = (): [number, number] => {
    const r = context.renderer.value;
    return [
      r?.domElement.clientWidth ?? 800,
      r?.domElement.clientHeight ?? 600,
    ];
  };

  // -----------------------------------------------------------------------
  // Entity resolution
  // -----------------------------------------------------------------------

  function resolveEntity(hitInfo: BrepHitInfo): BrepEntity | null {
    if (!context.findParentInstanceNode || !context.getFaceIdAtTriangle)
      return null;

    const mesh = hitInfo.object as THREE.Mesh;
    const instanceNode = context.findParentInstanceNode(mesh);
    if (!instanceNode) return null;

    const cam = context.camera.value;
    const wpp = cam ? worldPerPixel(cam.position.distanceTo(hitInfo.point)) : 0;

    // Resolve the face normal at the raycast hit (used for edge/point constraint planes)
    let hitFaceNormal = new THREE.Vector3(0, 1, 0);
    if (
      hitInfo.faceIndex !== null &&
      context.getFaceIdAtTriangle &&
      context.getBrepFaceData
    ) {
      const fId = context.getFaceIdAtTriangle(mesh, hitInfo.faceIndex);
      if (fId !== null) {
        const fd = context.getBrepFaceData(mesh, fId);
        if (fd) {
          hitFaceNormal = fd.normal
            .clone()
            .transformDirection(mesh.matrixWorld)
            .normalize();
        }
      }
    }

    if (context.findNearestBrepEdge && cam && wpp > 0) {
      const edgeHit = context.findNearestBrepEdge(instanceNode, hitInfo.point);
      if (edgeHit) {
        // Depth check: reject edges behind the visible hit surface.
        // Dot the vector from hit-point to edge-point with the outward face
        // normal. Negative means the edge is behind the surface. The small
        // tolerance (half a screen-pixel in world units) avoids rejecting
        // edges that sit exactly on the surface plane.
        const toEdge = edgeHit.closestPoint.clone().sub(hitInfo.point);
        const edgeBehindSurface = toEdge.dot(hitFaceNormal) < -wpp * 0.5;

        if (!edgeBehindSurface) {
          const edgeSnapDist = EDGE_SNAP_PX * wpp;
          const pointSnapDist = POINT_SNAP_PX * wpp;

          if (edgeHit.distance < edgeSnapDist) {
            const ep0 = edgeHit.edge.endpoints[0]
              .clone()
              .applyMatrix4(instanceNode.matrixWorld);
            const ep1 = edgeHit.edge.endpoints[1]
              .clone()
              .applyMatrix4(instanceNode.matrixWorld);
            const d0 = hitInfo.point.distanceTo(ep0);
            const d1 = hitInfo.point.distanceTo(ep1);
            const minEndpointDist = Math.min(d0, d1);

            if (minEndpointDist < pointSnapDist) {
              return {
                kind: "point",
                instanceNode,
                worldPoint: d0 < d1 ? ep0 : ep1,
                hitFaceNormal,
              };
            }

            return {
              kind: "edge",
              instanceNode,
              edgeId: edgeHit.edgeId,
              edge: edgeHit.edge,
              closestPoint: edgeHit.closestPoint,
              hitFaceNormal,
            };
          }

          // Even outside edge snap, check endpoints with the wider edge-snap radius
          const ep0 = edgeHit.edge.endpoints[0]
            .clone()
            .applyMatrix4(instanceNode.matrixWorld);
          const ep1 = edgeHit.edge.endpoints[1]
            .clone()
            .applyMatrix4(instanceNode.matrixWorld);
          const d0 = hitInfo.point.distanceTo(ep0);
          const d1 = hitInfo.point.distanceTo(ep1);
          const minEndpointDist = Math.min(d0, d1);

          if (minEndpointDist < edgeSnapDist) {
            return {
              kind: "point",
              instanceNode,
              worldPoint: d0 < d1 ? ep0 : ep1,
              hitFaceNormal,
            };
          }
        }
      }
    }

    // Fall back to face
    if (hitInfo.faceIndex !== null) {
      const faceId = context.getFaceIdAtTriangle(mesh, hitInfo.faceIndex);
      if (faceId !== null && context.getBrepFaceData) {
        const faceData = context.getBrepFaceData(mesh, faceId);
        if (faceData) {
          const worldNormal = faceData.normal
            .clone()
            .transformDirection(mesh.matrixWorld)
            .normalize();
          return {
            kind: "face",
            mesh,
            faceId,
            normal: worldNormal,
            hitPoint: hitInfo.point.clone(),
          };
        }
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Entity key (stable dedup identifier)
  // -----------------------------------------------------------------------

  function entityKey(entity: BrepEntity): string {
    if (entity.kind === "edge") {
      return `edge-${entity.instanceNode.id}-${entity.edgeId}`;
    }
    if (entity.kind === "point") {
      const p = entity.worldPoint;
      return `point-${p.x.toFixed(4)}-${p.y.toFixed(4)}-${p.z.toFixed(4)}`;
    }
    return `face-${entity.mesh.uuid}-${entity.faceId}`;
  }

  // -----------------------------------------------------------------------
  // Highlight creation
  // -----------------------------------------------------------------------

  function createEdgeHighlight(
    entity: BrepEntity & { kind: "edge" },
    color: number = HIGHLIGHT_COLOR,
  ): THREE.Object3D | null {
    if (!context.getBrepEdgeWorldPositions) return null;
    const worldSegs = context.getBrepEdgeWorldPositions(
      entity.instanceNode,
      entity.edgeId,
    );
    if (!worldSegs || worldSegs.length === 0) return null;

    const positions: number[] = [];
    for (const [a, b] of worldSegs) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);

    const [rw, rh] = getRendererResolution();
    const mat = new LineMaterial({
      color,
      linewidth: 4,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    mat.resolution.set(rw, rh);

    const line = new LineSegments2(geo, mat);
    line.renderOrder = 997;
    return line;
  }

  function createFaceHighlight(
    entity: BrepEntity & { kind: "face" },
    color: number = HIGHLIGHT_COLOR,
  ): THREE.Object3D | null {
    if (!context.getBrepFaceTrianglePositions) return null;
    const triPositions = context.getBrepFaceTrianglePositions(
      entity.mesh,
      entity.faceId,
    );
    if (!triPositions) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(triPositions, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const m = new THREE.Mesh(geo, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(entity.mesh.matrixWorld);
    m.matrixWorld.copy(entity.mesh.matrixWorld);
    m.renderOrder = 996;
    m.raycast = () => {};
    return m;
  }

  function createPointHighlight(
    entity: BrepEntity & { kind: "point" },
    color: number = POINT_HIGHLIGHT_COLOR,
  ): THREE.Object3D {
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const sphere = new THREE.Mesh(getSphereGeo(), mat);
    sphere.position.copy(entity.worldPoint);
    sphere.renderOrder = 998;
    sphere.raycast = () => {};
    const cam = context.camera.value;
    if (cam) {
      const dist = cam.position.distanceTo(entity.worldPoint);
      const s = POINT_HIGHLIGHT_SCREEN_PX * worldPerPixel(dist);
      sphere.scale.set(s, s, s);
    }
    return sphere;
  }

  // -----------------------------------------------------------------------
  // Highlight management
  // -----------------------------------------------------------------------

  function clearHighlights(): void {
    for (const obj of currentHighlightObjects) {
      context.scene.value?.remove(obj);
      obj.traverse((child) => {
        const m = child as any;
        if (m.geometry && m.geometry !== getSphereGeo()) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material))
            m.material.forEach((mm: THREE.Material) => mm.dispose());
          else m.material.dispose();
        }
      });
    }
    currentHighlightObjects = [];
    currentHighlightKey = "";
  }

  function showHighlight(entity: BrepEntity, color?: number): void {
    const key = entityKey(entity);
    if (key === currentHighlightKey) return;

    clearHighlights();
    currentHighlightKey = key;

    let obj: THREE.Object3D | null;
    if (entity.kind === "point") {
      obj = createPointHighlight(entity, color);
    } else if (entity.kind === "edge") {
      obj = createEdgeHighlight(entity, color);
    } else {
      obj = createFaceHighlight(entity, color);
    }

    if (obj) {
      context.scene.value?.add(obj);
      currentHighlightObjects.push(obj);
    }
  }

  // -----------------------------------------------------------------------
  // Throttled hover handler
  // -----------------------------------------------------------------------

  /**
   * Convenience: throttled hover handler that resolves the entity
   * under the cursor and shows a highlight. Returns the resolved entity
   * (or null) so the consuming tool can react to it.
   */
  function handleHover(event: PointerEvent): BrepEntity | null {
    const now = performance.now();
    if (now - lastHoverTime < HOVER_THROTTLE_MS) return null;
    lastHoverTime = now;

    const hitInfo = context.getHitInfo(event);
    if (!hitInfo) {
      clearHighlights();
      return null;
    }

    const entity = resolveEntity(hitInfo);
    if (!entity) {
      clearHighlights();
      return null;
    }

    showHighlight(entity);
    return entity;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    resolveEntity,
    entityKey,
    showHighlight,
    clearHighlights,
    createEdgeHighlight,
    createFaceHighlight,
    createPointHighlight,
    handleHover,
    worldPerPixel,
    getRendererResolution,
  };
}
