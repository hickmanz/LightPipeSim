import { reactive, ref, shallowRef, type ShallowRef } from "vue";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { Earcut } from "three/src/extras/Earcut.js";
import { MeshBVH } from "three-mesh-bvh";
import {
  getCapWorkerManager,
  type CapGeometryResult,
} from "../../workers/capWorkerManager";
import type {
  CartesianAxis,
  PlaneAxis,
  SectionPlaneState,
  SectionSnapshot,
  SectionPlanesContext,
  PlaneCapResources,
} from "../../types/section";

// Re-export types for convenience
export type {
  CartesianAxis,
  PlaneAxis,
  SectionPlaneState,
  SectionSnapshot,
  SectionPlanesContext,
  PlaneCapResources,
};

export interface DragAnnotation {
  visible: boolean;
  x: number;
  y: number;
  text: string;
}

/**
 * Composable for managing section/cutting planes in the Three.js viewer.
 * Handles plane creation, visualization, dragging, and cap geometry computation.
 */
export function useSectionPlanes(context: SectionPlanesContext) {
  // ============================================================================
  // State
  // ============================================================================

  // Cutting plane refs (THREE.Plane for clipping)
  const cuttingPlaneX = shallowRef<THREE.Plane | null>(null);
  const cuttingPlaneY = shallowRef<THREE.Plane | null>(null);
  const cuttingPlaneZ = shallowRef<THREE.Plane | null>(null);

  // Visual gizmo groups (replaced large plane meshes)
  const cuttingPlaneMeshX = shallowRef<THREE.Group | null>(null);
  const cuttingPlaneMeshY = shallowRef<THREE.Group | null>(null);
  const cuttingPlaneMeshZ = shallowRef<THREE.Group | null>(null);

  // State
  const cuttingPlanesVisible = ref(false);
  const activeCuttingPlanes = ref<Set<PlaneAxis>>(new Set());
  const showSectionEdges = ref(true);
  /** Fill the cut faces ("cap the ends"). Off = see into the hollow parts through the cut. */
  const showSectionCaps = ref(true);

  // Per-axis distance from world origin
  const planeDistances = reactive<Record<PlaneAxis, number>>({
    x: 0,
    y: 0,
    z: 0,
    face: 0,
  });

  // Drag annotation overlay state
  const dragAnnotation = reactive<DragAnnotation>({
    visible: false,
    x: 0,
    y: 0,
    text: "",
  });

  // Cap resources for each plane
  const planeCapResources = new Map<PlaneAxis, PlaneCapResources>();
  const edgesDirty = new Set<PlaneAxis>();

  // Dragging state
  let draggingPlane: PlaneAxis | null = null;
  let dragStartPoint: THREE.Vector3 | null = null;

  // Deferred cap computation state (per-axis)
  const pendingCapAxes = new Set<PlaneAxis>();
  let capUpdateTimeoutId: number | null = null;
  let capUpdateVersion = 0;
  const CAP_UPDATE_DELAY_MS = 50;

  // Track flip state per axis for snapshot/restore
  const flipState = new Map<PlaneAxis, boolean>([
    ["x", false],
    ["y", false],
    ["z", false],
  ]);

  // Gizmo sizing constants (in gizmo-local units; group is scaled to GIZMO_QUAD_PX each frame)
  const GIZMO_QUAD_PX = 110;
  const GIZMO_AXIS_HALF_LEN = 100; // effectively infinite on screen
  const GIZMO_HANDLE_OFFSET = 0.7; // distance from center to the drag dot
  const GIZMO_HANDLE_RADIUS = 0.1;
  const GIZMO_STEM_RADIUS = 0.02; // thicker stem cylinder to the handle
  const GIZMO_VIEWPORT_MARGIN_NDC = 0.3; // keep handles farther from screen edges

  // Raycaster for drag detection
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line = { threshold: 0 };
  raycaster.params.Points = { threshold: 0 };

  // Temp vectors for edge computation
  const tempVector = new THREE.Vector3();
  const tempVector1 = new THREE.Vector3();
  const tempVector2 = new THREE.Vector3();
  const tempVector3 = new THREE.Vector3();
  const tempLine = new THREE.Line3();
  const inverseMatrix = new THREE.Matrix4();
  const localPlane = new THREE.Plane();

  // ============================================================================
  // Helper Functions
  // ============================================================================

  const nullPlaneRef = shallowRef<THREE.Plane | null>(null);
  const nullMeshRef = shallowRef<THREE.Group | null>(null);

  const getPlaneRef = (axis: PlaneAxis): ShallowRef<THREE.Plane | null> => {
    if (axis === "x") return cuttingPlaneX;
    if (axis === "y") return cuttingPlaneY;
    if (axis === "z") return cuttingPlaneZ;
    return nullPlaneRef;
  };

  const getPlaneMeshRef = (axis: PlaneAxis): ShallowRef<THREE.Group | null> => {
    if (axis === "x") return cuttingPlaneMeshX;
    if (axis === "y") return cuttingPlaneMeshY;
    if (axis === "z") return cuttingPlaneMeshZ;
    return nullMeshRef;
  };

  const getNormalizedCoords = (
    event: MouseEvent | PointerEvent,
  ): THREE.Vector2 => {
    const canvas = context.getCanvas();
    if (!canvas) return new THREE.Vector2();

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const width = canvas.clientWidth || rect.width;
    const height = canvas.clientHeight || rect.height;

    return new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
  };

  // ============================================================================
  // Gizmo Creation
  // ============================================================================

  const getWorldPerPixel = (distance: number): number => {
    const cam = context.camera.value;
    const rend = context.renderer.value;
    const viewportHeight = rend?.domElement.clientHeight || 1;
    if (!cam) return 1;
    if (cam instanceof THREE.PerspectiveCamera) {
      const fovRad = THREE.MathUtils.degToRad(cam.fov);
      return (2 * distance * Math.tan(fovRad / 2)) / viewportHeight;
    }
    const ortho = cam as THREE.OrthographicCamera;
    return (ortho.top - ortho.bottom) / (ortho.zoom * viewportHeight);
  };

  const createPlaneGizmo = (
    normal: THREE.Vector3,
    color: number,
  ): THREE.Group => {
    const group = new THREE.Group();

    // All gizmo materials must be transparent so they share the transparent
    // render pass with cap meshes. renderOrder then sorts them correctly
    // (caps = 2, gizmo = 10+), preventing caps from drawing over the gizmo.

    // Semi-transparent quad (1x1 gizmo units)
    const quadGeo = new THREE.PlaneGeometry(1, 1);
    const quadMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const quad = new THREE.Mesh(quadGeo, quadMat);
    quad.lookAt(normal);
    quad.renderOrder = 10;
    group.add(quad);

    // Main axis line — very long so the ends are never visible
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      normal.clone().multiplyScalar(-GIZMO_AXIS_HALF_LEN),
      normal.clone().multiplyScalar(GIZMO_AXIS_HALF_LEN),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      depthWrite: false,
    });
    const axisLine = new THREE.Line(lineGeo, lineMat);
    axisLine.renderOrder = 11;
    group.add(axisLine);

    // Thicker stem from plane center to the drag handle (cylinder)
    const negNormal = normal.clone().negate();
    const stemGeo = new THREE.CylinderGeometry(
      GIZMO_STEM_RADIUS,
      GIZMO_STEM_RADIUS,
      GIZMO_HANDLE_OFFSET,
      8,
      1,
    );
    stemGeo.rotateX(Math.PI / 2);
    const stemMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const stem = new THREE.Mesh(stemGeo, stemMat);
    // Orient cylinder along the normal, centered between origin and handle
    stem.position.copy(
      negNormal.clone().multiplyScalar(GIZMO_HANDLE_OFFSET / 2),
    );
    stem.lookAt(negNormal);
    stem.renderOrder = 12;
    group.add(stem);

    // Drag handle dot on the negative-normal side of the plane
    const handleGeo = new THREE.SphereGeometry(GIZMO_HANDLE_RADIUS, 16, 12);
    const handleMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    const handle = new THREE.Mesh(handleGeo, handleMat);
    handle.position.copy(negNormal.clone().multiplyScalar(GIZMO_HANDLE_OFFSET));
    handle.renderOrder = 13;
    handle.userData.isDragHandle = true;
    group.add(handle);

    group.userData.isCuttingPlane = true;
    return group;
  };

  const disposeGizmo = (group: THREE.Group) => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else (mat as THREE.Material).dispose();
      }
    });
  };

  const updatePlaneDistance = (axis: PlaneAxis) => {
    if (axis === "face") return;
    const meshRef = getPlaneMeshRef(axis);
    if (meshRef.value) {
      planeDistances[axis] = meshRef.value.position[axis];
    }
  };

  // ============================================================================
  // Edge Lines
  // ============================================================================

  const createEdgeLines = (maxPoints: number) => {
    const positions = new Float32Array(maxPoints * 3);

    const lineGeometry = new LineSegmentsGeometry();
    lineGeometry.setPositions([0, 0, 0, 0, 0, 0]);

    const lineMaterial = new LineMaterial({
      color: 0x94979c,
      linewidth: 1.5,
      depthTest: true,
      depthWrite: false,
      vertexColors: false,
      dashed: false,
      transparent: false,
    });
    lineMaterial.resolution.set(window.innerWidth, window.innerHeight);

    const lines = new LineSegments2(lineGeometry, lineMaterial);
    lines.frustumCulled = false;
    lines.renderOrder = 3;

    return { lines, positions, material: lineMaterial };
  };

  // ============================================================================
  // Cap Mesh
  // ============================================================================

  const createCapMaterial = (color: number = 0x666666) => {
    return new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      transparent: true, // Render in transparent pass so caps draw AFTER transparent parts
      opacity: 1.0, // Always fully opaque
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  };

  const createCapMeshWithGeometry = (
    geometry: THREE.BufferGeometry,
  ): THREE.Mesh => {
    const material = createCapMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    return mesh;
  };

  // ============================================================================
  // Edge Computation (BVH-based)
  // ============================================================================

  const updateClippedEdgesForPlaneAsync = async (
    resources: PlaneCapResources,
  ) => {
    const { plane, edgeLines, edgePositions } = resources;
    const bvhMeshes = context.bvhMeshes.value;
    if (!bvhMeshes.length) return;

    let index = 0;
    let lastYield = performance.now();

    for (let meshIdx = 0; meshIdx < bvhMeshes.length; meshIdx++) {
      const mesh = bvhMeshes[meshIdx];
      // Skip hidden meshes (from Hide / Isolate actions)
      if (!mesh.visible) continue;

      const geometry = mesh.geometry as THREE.BufferGeometry & {
        boundsTree?: unknown;
      };
      const bvh = geometry.boundsTree as MeshBVH | undefined;
      if (!bvh) continue;

      inverseMatrix.copy(mesh.matrixWorld).invert();
      localPlane.copy(plane).applyMatrix4(inverseMatrix);

      bvh.shapecast({
        intersectsBounds: (box: THREE.Box3) => localPlane.intersectsBox(box),
        intersectsTriangle: (tri: {
          a: THREE.Vector3;
          b: THREE.Vector3;
          c: THREE.Vector3;
        }) => {
          let count = 0;

          const pushHit = () => {
            tempVector.applyMatrix4(mesh.matrixWorld);
            edgePositions[index * 3] = tempVector.x;
            edgePositions[index * 3 + 1] = tempVector.y;
            edgePositions[index * 3 + 2] = tempVector.z;
            index++;
            count++;
          };

          tempLine.start.copy(tri.a);
          tempLine.end.copy(tri.b);
          if (localPlane.intersectLine(tempLine, tempVector)) pushHit();

          tempLine.start.copy(tri.b);
          tempLine.end.copy(tri.c);
          if (localPlane.intersectLine(tempLine, tempVector)) pushHit();

          tempLine.start.copy(tri.c);
          tempLine.end.copy(tri.a);
          if (localPlane.intersectLine(tempLine, tempVector)) pushHit();

          if (count === 3) {
            tempVector1.set(
              edgePositions[(index - 3) * 3],
              edgePositions[(index - 3) * 3 + 1],
              edgePositions[(index - 3) * 3 + 2],
            );
            tempVector2.set(
              edgePositions[(index - 2) * 3],
              edgePositions[(index - 2) * 3 + 1],
              edgePositions[(index - 2) * 3 + 2],
            );
            tempVector3.set(
              edgePositions[(index - 1) * 3],
              edgePositions[(index - 1) * 3 + 1],
              edgePositions[(index - 1) * 3 + 2],
            );

            if (
              tempVector3.equals(tempVector1) ||
              tempVector3.equals(tempVector2)
            ) {
              count--;
              index--;
            } else if (tempVector1.equals(tempVector2)) {
              edgePositions[(index - 2) * 3] = tempVector3.x;
              edgePositions[(index - 2) * 3 + 1] = tempVector3.y;
              edgePositions[(index - 2) * 3 + 2] = tempVector3.z;
              count--;
              index--;
            }
          }

          if (count !== 2) {
            index -= count;
          }
        },
      });

      // Yield every ~16ms
      const now = performance.now();
      if (now - lastYield > 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }

    const positionsToSet = Array.from(edgePositions.slice(0, index * 3));
    const oldGeom = (edgeLines as LineSegments2).geometry;
    const newGeom = new LineSegmentsGeometry();

    if (positionsToSet.length >= 6) {
      newGeom.setPositions(positionsToSet);
    } else {
      newGeom.setPositions([0, 0, 0, 0, 0, 0]);
    }

    (edgeLines as LineSegments2).geometry = newGeom;
    oldGeom.dispose();
    (edgeLines as LineSegments2).computeLineDistances();
    newGeom.computeBoundingSphere();
    edgeLines.position.copy(plane.normal).multiplyScalar(-0.0001);

    // Restore edge visibility based on showSectionEdges setting
    edgeLines.visible = showSectionEdges.value;
  };

  // ============================================================================
  // Cap Geometry Computation
  // ============================================================================

  type EdgeSegment = {
    start: THREE.Vector3;
    end: THREE.Vector3;
    colorIndex: number;
  };

  type PolygonLoop = THREE.Vector3[];

  type SegmentCollectionResult = {
    segments: EdgeSegment[];
    colors: number[];
  };

  type PlaneBasis = {
    u: THREE.Vector3;
    v: THREE.Vector3;
    origin: THREE.Vector3;
  };

  const getMeshColor = (mesh: THREE.Mesh): number => {
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat && "color" in mat && (mat as any).color instanceof THREE.Color) {
      return (mat as any).color.getHex();
    }
    return 0x666666;
  };

  const collectEdgeSegmentsFromMesh = (
    mesh: THREE.Mesh,
    plane: THREE.Plane,
    segments: EdgeSegment[],
    colorIndex: number,
  ): void => {
    const geometry = mesh.geometry as THREE.BufferGeometry & {
      boundsTree?: unknown;
    };
    const bvh = geometry.boundsTree as MeshBVH | undefined;
    if (!bvh) return;

    const segTempVector = new THREE.Vector3();
    const segTempLine = new THREE.Line3();
    const segInverseMatrix = new THREE.Matrix4();
    const segLocalPlane = new THREE.Plane();

    segInverseMatrix.copy(mesh.matrixWorld).invert();
    segLocalPlane.copy(plane).applyMatrix4(segInverseMatrix);

    bvh.shapecast({
      intersectsBounds: (box: THREE.Box3) => segLocalPlane.intersectsBox(box),
      intersectsTriangle: (tri: {
        a: THREE.Vector3;
        b: THREE.Vector3;
        c: THREE.Vector3;
      }) => {
        const hits: THREE.Vector3[] = [];

        segTempLine.start.copy(tri.a);
        segTempLine.end.copy(tri.b);
        if (segLocalPlane.intersectLine(segTempLine, segTempVector)) {
          hits.push(segTempVector.clone().applyMatrix4(mesh.matrixWorld));
        }

        segTempLine.start.copy(tri.b);
        segTempLine.end.copy(tri.c);
        if (segLocalPlane.intersectLine(segTempLine, segTempVector)) {
          hits.push(segTempVector.clone().applyMatrix4(mesh.matrixWorld));
        }

        segTempLine.start.copy(tri.c);
        segTempLine.end.copy(tri.a);
        if (segLocalPlane.intersectLine(segTempLine, segTempVector)) {
          hits.push(segTempVector.clone().applyMatrix4(mesh.matrixWorld));
        }

        if (hits.length === 3) {
          const eps = 1e-9;
          if (
            hits[2].distanceToSquared(hits[0]) < eps ||
            hits[2].distanceToSquared(hits[1]) < eps
          ) {
            hits.pop();
          } else if (hits[0].distanceToSquared(hits[1]) < eps) {
            hits[1].copy(hits[2]);
            hits.pop();
          }
        }

        if (hits.length === 2) {
          segments.push({ start: hits[0], end: hits[1], colorIndex });
        }
      },
    });
  };

  const collectEdgeSegmentsAsync = async (
    plane: THREE.Plane,
  ): Promise<SegmentCollectionResult> => {
    const segments: EdgeSegment[] = [];
    const colors: number[] = [];
    const colorToIndex = new Map<number, number>();
    const bvhMeshes = context.bvhMeshes.value;

    if (!bvhMeshes.length) return { segments, colors };

    let lastYield = performance.now();

    for (let i = 0; i < bvhMeshes.length; i++) {
      // Skip hidden meshes (from Hide / Isolate actions)
      if (!bvhMeshes[i].visible) continue;

      const now = performance.now();
      if (now - lastYield > 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }

      const meshColor = getMeshColor(bvhMeshes[i]);
      let colorIndex = colorToIndex.get(meshColor);
      if (colorIndex === undefined) {
        colorIndex = colors.length;
        colors.push(meshColor);
        colorToIndex.set(meshColor, colorIndex);
      }

      collectEdgeSegmentsFromMesh(bvhMeshes[i], plane, segments, colorIndex);
    }

    return { segments, colors };
  };

  const connectSegmentsToLoops = (
    segments: EdgeSegment[],
    epsilon: number = 1e-4,
  ): PolygonLoop[] => {
    if (segments.length === 0) return [];

    const quantize = (v: THREE.Vector3): string => {
      const scale = 1 / epsilon;
      return `${Math.round(v.x * scale)},${Math.round(v.y * scale)},${Math.round(v.z * scale)}`;
    };

    type VertexRef = { segmentIndex: number; isStart: boolean };
    const adjacency = new Map<string, VertexRef[]>();

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const startKey = quantize(seg.start);
      const endKey = quantize(seg.end);

      if (!adjacency.has(startKey)) adjacency.set(startKey, []);
      if (!adjacency.has(endKey)) adjacency.set(endKey, []);

      adjacency.get(startKey)!.push({ segmentIndex: i, isStart: true });
      adjacency.get(endKey)!.push({ segmentIndex: i, isStart: false });
    }

    const used = new Set<number>();
    const loops: PolygonLoop[] = [];

    for (let startSegIdx = 0; startSegIdx < segments.length; startSegIdx++) {
      if (used.has(startSegIdx)) continue;

      const loop: THREE.Vector3[] = [];
      const currentSegIdx = startSegIdx;
      let currentVertex = segments[currentSegIdx].start.clone();
      const startVertex = currentVertex.clone();
      const startKey = quantize(startVertex);
      let naturallyClosed = false;

      loop.push(currentVertex.clone());
      used.add(currentSegIdx);
      currentVertex = segments[currentSegIdx].end.clone();
      loop.push(currentVertex.clone());

      let maxIterations = segments.length + 1;
      while (maxIterations-- > 0) {
        const currentKey = quantize(currentVertex);
        const distToStart = currentVertex.distanceToSquared(startVertex);
        const isClosed =
          currentKey === startKey || distToStart < epsilon * epsilon;

        if (isClosed && loop.length > 2) {
          loop.pop();
          naturallyClosed = true;
          break;
        }

        const refs = adjacency.get(currentKey);
        if (!refs) break;

        let foundNext = false;
        for (const ref of refs) {
          if (used.has(ref.segmentIndex)) continue;

          used.add(ref.segmentIndex);
          const nextSeg = segments[ref.segmentIndex];

          if (ref.isStart) {
            currentVertex = nextSeg.end.clone();
          } else {
            currentVertex = nextSeg.start.clone();
          }

          loop.push(currentVertex.clone());
          foundNext = true;
          break;
        }

        if (!foundNext) break;
      }

      if (loop.length >= 3 && naturallyClosed) {
        loops.push(loop);
      }
    }

    return loops;
  };

  const createPlaneBasis = (plane: THREE.Plane): PlaneBasis => {
    const normal = plane.normal.clone().normalize();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();

    if (Math.abs(normal.x) < 0.9) {
      u.crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
    } else {
      u.crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
    }
    v.crossVectors(normal, u).normalize();

    const origin = new THREE.Vector3();
    plane.coplanarPoint(origin);

    return { u, v, origin };
  };

  const projectLoopTo2D = (loop: PolygonLoop, basis: PlaneBasis): number[] => {
    const points2D: number[] = [];
    const rel = new THREE.Vector3();

    for (const p of loop) {
      rel.copy(p).sub(basis.origin);
      points2D.push(rel.dot(basis.u), rel.dot(basis.v));
    }

    return points2D;
  };

  const signedArea2D = (points2D: number[]): number => {
    let area = 0;
    const n = points2D.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += points2D[i * 2] * points2D[j * 2 + 1];
      area -= points2D[j * 2] * points2D[i * 2 + 1];
    }
    return area / 2;
  };

  const pointInPolygon2D = (
    px: number,
    py: number,
    points2D: number[],
  ): boolean => {
    let inside = false;
    const n = points2D.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = points2D[i * 2],
        yi = points2D[i * 2 + 1];
      const xj = points2D[j * 2],
        yj = points2D[j * 2 + 1];

      if (
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  };

  const classifyLoops = (
    loops: PolygonLoop[],
    basis: PlaneBasis,
  ): {
    outerLoops: PolygonLoop[];
    holesByOuter: Map<number, PolygonLoop[]>;
  } => {
    if (loops.length === 0) {
      return { outerLoops: [], holesByOuter: new Map() };
    }

    const projected: {
      loop: PolygonLoop;
      points2D: number[];
      area: number;
      isOuter: boolean;
    }[] = [];

    for (const loop of loops) {
      const points2D = projectLoopTo2D(loop, basis);
      const area = signedArea2D(points2D);
      projected.push({ loop, points2D, area, isOuter: true });
    }

    projected.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

    const holesByOuter = new Map<number, PolygonLoop[]>();
    const outerIndices: number[] = [];

    for (let i = 0; i < projected.length; i++) {
      const current = projected[i];
      let isHole = false;
      let parentIndex = -1;

      const testX = current.points2D[0];
      const testY = current.points2D[1];

      for (let j = 0; j < i; j++) {
        if (!projected[j].isOuter) continue;

        if (pointInPolygon2D(testX, testY, projected[j].points2D)) {
          if (current.area > 0 !== projected[j].area > 0) {
            isHole = true;
            parentIndex = j;
            break;
          }
        }
      }

      if (isHole && parentIndex >= 0) {
        current.isOuter = false;
        if (!holesByOuter.has(parentIndex)) {
          holesByOuter.set(parentIndex, []);
        }
        holesByOuter.get(parentIndex)!.push(current.loop);
      } else {
        outerIndices.push(i);
      }
    }

    const outerLoops: PolygonLoop[] = [];
    const outerIndexMap = new Map<number, number>();

    for (let i = 0; i < outerIndices.length; i++) {
      const projIdx = outerIndices[i];
      outerLoops.push(projected[projIdx].loop);
      outerIndexMap.set(projIdx, i);
    }

    const remappedHoles = new Map<number, PolygonLoop[]>();
    for (const [projIdx, holes] of holesByOuter) {
      const outerIdx = outerIndexMap.get(projIdx);
      if (outerIdx !== undefined) {
        remappedHoles.set(outerIdx, holes);
      }
    }

    return { outerLoops, holesByOuter: remappedHoles };
  };

  const ensureCCW = (points2D: number[]): number[] => {
    const area = signedArea2D(points2D);
    if (area < 0) {
      const reversed: number[] = [];
      const n = points2D.length / 2;
      for (let i = n - 1; i >= 0; i--) {
        reversed.push(points2D[i * 2], points2D[i * 2 + 1]);
      }
      return reversed;
    }
    return points2D;
  };

  const ensureCW = (points2D: number[]): number[] => {
    const area = signedArea2D(points2D);
    if (area > 0) {
      const reversed: number[] = [];
      const n = points2D.length / 2;
      for (let i = n - 1; i >= 0; i--) {
        reversed.push(points2D[i * 2], points2D[i * 2 + 1]);
      }
      return reversed;
    }
    return points2D;
  };

  const triangulatePolygonWithHoles = (
    outerLoop2D: number[],
    holes2D: number[][],
  ): { vertices2D: number[]; indices: number[] } => {
    const normalizedOuter = ensureCCW(outerLoop2D);
    const normalizedHoles = holes2D.map((hole) => ensureCW(hole));

    const vertices2D: number[] = [...normalizedOuter];
    const holeIndices: number[] = [];

    for (const hole of normalizedHoles) {
      holeIndices.push(vertices2D.length / 2);
      vertices2D.push(...hole);
    }

    const indices = Earcut.triangulate(
      vertices2D,
      holeIndices.length > 0 ? holeIndices : undefined,
      2,
    );

    return { vertices2D, indices };
  };

  const buildCapGeometry = (
    loops: PolygonLoop[],
    holesByOuter: Map<number, PolygonLoop[]>,
    basis: PlaneBasis,
    planeNormal: THREE.Vector3,
  ): THREE.BufferGeometry => {
    const allPositions: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;

    for (let i = 0; i < loops.length; i++) {
      const outerLoop = loops[i];
      const holes = holesByOuter.get(i) || [];

      const outer2D = projectLoopTo2D(outerLoop, basis);
      const holes2D = holes.map((hole) => projectLoopTo2D(hole, basis));

      const { vertices2D, indices } = triangulatePolygonWithHoles(
        outer2D,
        holes2D,
      );

      const numVerts = vertices2D.length / 2;
      for (let j = 0; j < numVerts; j++) {
        const x2d = vertices2D[j * 2];
        const y2d = vertices2D[j * 2 + 1];

        const x3d = basis.origin.x + x2d * basis.u.x + y2d * basis.v.x;
        const y3d = basis.origin.y + x2d * basis.u.y + y2d * basis.v.y;
        const z3d = basis.origin.z + x2d * basis.u.z + y2d * basis.v.z;

        allPositions.push(x3d, y3d, z3d);
      }

      for (const idx of indices) {
        allIndices.push(idx + vertexOffset);
      }

      vertexOffset += numVerts;
    }

    const geometry = new THREE.BufferGeometry();

    if (allPositions.length > 0) {
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(allPositions, 3),
      );
      geometry.setIndex(allIndices);

      const normals: number[] = [];
      const numVertices = allPositions.length / 3;
      for (let i = 0; i < numVertices; i++) {
        normals.push(planeNormal.x, planeNormal.y, planeNormal.z);
      }
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(normals, 3),
      );
    }

    return geometry;
  };

  const filterDegenerateLoops = (
    loops: PolygonLoop[],
    basis: PlaneBasis,
    minArea: number = 1e-8,
  ): PolygonLoop[] => {
    return loops.filter((loop) => {
      const points2D = projectLoopTo2D(loop, basis);
      const area = Math.abs(signedArea2D(points2D));
      return area > minArea;
    });
  };

  const computeCapGeometryAsync = async (
    plane: THREE.Plane,
    isCancelled: () => boolean,
  ): Promise<CapGeometryResult> => {
    const { segments, colors } = await collectEdgeSegmentsAsync(plane);

    if (isCancelled()) return null;

    if (segments.length === 0) {
      return { geometry: new THREE.BufferGeometry(), colors: [] };
    }

    const workerManager = getCapWorkerManager();

    if (!workerManager.isAvailable()) {
      console.warn("[Cap] Worker not available, falling back to main thread");
      return computeCapGeometryMainThread(plane, segments, colors);
    }

    try {
      const result = await workerManager.processSegments(
        segments,
        colors,
        plane,
      );

      if (isCancelled()) return null;

      return workerManager.createBufferGeometry(THREE, result);
    } catch (error) {
      console.error("[Cap] Worker error, falling back to main thread:", error);
      return computeCapGeometryMainThread(plane, segments, colors);
    }
  };

  const computeCapGeometryMainThread = (
    plane: THREE.Plane,
    segments: EdgeSegment[],
    colors: number[],
  ): CapGeometryResult => {
    const loops = connectSegmentsToLoops(segments);

    if (loops.length === 0) {
      return { geometry: new THREE.BufferGeometry(), colors: [] };
    }

    const basis = createPlaneBasis(plane);
    const validLoops = filterDegenerateLoops(loops, basis);

    if (validLoops.length === 0) {
      return { geometry: new THREE.BufferGeometry(), colors: [] };
    }

    const { outerLoops, holesByOuter } = classifyLoops(validLoops, basis);

    if (outerLoops.length === 0) {
      return { geometry: new THREE.BufferGeometry(), colors: [] };
    }

    const geometry = buildCapGeometry(
      outerLoops,
      holesByOuter,
      basis,
      plane.normal,
    );
    return { geometry, colors: colors.length > 0 ? colors : [0x666666] };
  };

  // ============================================================================
  // Cap Resources Management
  // ============================================================================

  const createPlaneCapResources = (axis: PlaneAxis, plane: THREE.Plane) => {
    const sceneVal = context.scene.value;
    if (!sceneVal) return;
    if (planeCapResources.has(axis)) return;

    const emptyGeometry = new THREE.BufferGeometry();
    const capMesh = createCapMeshWithGeometry(emptyGeometry);
    capMesh.visible = false;

    const maxPoints = 2;
    const { lines: edgeLines, positions } = createEdgeLines(maxPoints);
    edgeLines.visible = showSectionEdges.value;

    sceneVal.add(capMesh);
    sceneVal.add(edgeLines);

    planeCapResources.set(axis, {
      plane: plane.clone(),
      capMesh,
      edgeLines,
      edgePositions: positions,
    });

    updateCapClipping();
    scheduleCapUpdate(axis);
  };

  const removePlaneCapResources = (axis: PlaneAxis) => {
    pendingCapAxes.delete(axis);
    // If no more pending axes, cancel the debounce timer
    if (pendingCapAxes.size === 0 && capUpdateTimeoutId !== null) {
      clearTimeout(capUpdateTimeoutId);
      capUpdateTimeoutId = null;
    }

    const resources = planeCapResources.get(axis);
    const sceneVal = context.scene.value;
    if (!resources || !sceneVal) return;

    sceneVal.remove(resources.capMesh);
    sceneVal.remove(resources.edgeLines);

    resources.capMesh.geometry.dispose();
    // Handle material disposal - could be single material or array
    const capMaterial = resources.capMesh.material;
    if (Array.isArray(capMaterial)) {
      capMaterial.forEach((m) => m.dispose());
    } else if (capMaterial && typeof capMaterial.dispose === "function") {
      capMaterial.dispose();
    }

    (resources.edgeLines as LineSegments2).geometry.dispose();
    const edgeMaterial = (resources.edgeLines as LineSegments2).material;
    if (Array.isArray(edgeMaterial)) {
      edgeMaterial.forEach((m) => m.dispose());
    } else if (edgeMaterial && typeof edgeMaterial.dispose === "function") {
      edgeMaterial.dispose();
    }

    planeCapResources.delete(axis);
    edgesDirty.delete(axis);
    updateCapClipping();
  };

  const clearAllPlaneCapResources = () => {
    for (const axis of Array.from(planeCapResources.keys())) {
      removePlaneCapResources(axis);
    }
  };

  // ============================================================================
  // Cap Update Scheduling
  // ============================================================================

  const scheduleCapUpdate = (axis: PlaneAxis) => {
    pendingCapAxes.add(axis);
    capUpdateVersion++;
    if (capUpdateTimeoutId !== null) return; // timer already running, axis is queued
    capUpdateTimeoutId = window.setTimeout(() => {
      capUpdateTimeoutId = null;
      const axes = [...pendingCapAxes];
      pendingCapAxes.clear();
      for (const a of axes) {
        performCapUpdateAsync(a);
      }
    }, CAP_UPDATE_DELAY_MS);
  };

  const performCapUpdateAsync = async (axis: PlaneAxis) => {
    try {
      const resources = planeCapResources.get(axis);
      const planeRef = getPlaneRef(axis);
      if (!resources || !planeRef.value) return;

      const startVersion = capUpdateVersion;
      const isCancelled = () => capUpdateVersion !== startVersion;

      // Get triangle count from BVH meshes
      let triangleCount = 0;
      for (const mesh of context.bvhMeshes.value) {
        const geometry = mesh.geometry as THREE.BufferGeometry;
        const index = geometry.index;
        const position = geometry.attributes.position as
          | THREE.BufferAttribute
          | undefined;
        if (index) {
          triangleCount += index.count / 3;
        } else if (position) {
          triangleCount += position.count / 3;
        }
      }

      const requiredPoints = Math.max(2, triangleCount * 2);
      if (resources.edgePositions.length < requiredPoints * 3) {
        const newPositions = new Float32Array(requiredPoints * 3);
        resources.edgePositions = newPositions;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (isCancelled()) return;
      }

      const result = await computeCapGeometryAsync(planeRef.value, isCancelled);

      if (!result || isCancelled()) return;

      const { geometry, colors } = result;

      resources.capMesh.geometry.dispose();
      resources.capMesh.geometry = geometry;

      if (colors.length > 0) {
        const materials = colors.map((color) => createCapMaterial(color));
        const oldMat = resources.capMesh.material;
        if (Array.isArray(oldMat)) {
          oldMat.forEach((m) => m.dispose());
        } else {
          oldMat.dispose();
        }
        resources.capMesh.material = materials;
      }

      resources.capMesh.visible = showSectionCaps.value;
      resources.plane.copy(planeRef.value);

      scheduleEdgeUpdate(axis);
      updateCapClipping();
    } catch (error) {
      console.error(`[Cap] Error in performCapUpdateAsync:`, error);
    }
  };

  const scheduleEdgeUpdate = (axis: PlaneAxis) => {
    requestAnimationFrame(() => {
      const resources = planeCapResources.get(axis);
      if (resources) {
        updateClippedEdgesForPlaneAsync(resources);
      }
    });
  };

  // ============================================================================
  // Material Clipping
  // ============================================================================

  const updateMaterialClipping = () => {
    const planes: THREE.Plane[] = [];
    if (cuttingPlaneX.value) planes.push(cuttingPlaneX.value);
    if (cuttingPlaneY.value) planes.push(cuttingPlaneY.value);
    if (cuttingPlaneZ.value) planes.push(cuttingPlaneZ.value);

    const clippingPlanesToApply = planes.length > 0 ? planes : null;

    // Update the original cached materials (edge lines, etc.)
    const materials = context.getCachedMaterials();
    for (const mat of materials) {
      mat.clippingPlanes = clippingPlanesToApply;
      mat.clipShadows = true;
      mat.needsUpdate = true;
    }

    // Also update *current* materials on all BVH meshes.
    // This catches cloned materials from transparency / highlight that aren't
    // in the cached list (e.g. when toggleTransparency clones a material).
    const bvhMeshes = context.bvhMeshes.value;
    for (const mesh of bvhMeshes) {
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) {
        if (mat.clippingPlanes !== clippingPlanesToApply) {
          mat.clippingPlanes = clippingPlanesToApply;
          mat.clipShadows = true;
          mat.needsUpdate = true;
        }
      }
    }
  };

  const updateCapClipping = () => {
    for (const [axis, resources] of planeCapResources) {
      const otherPlanes: THREE.Plane[] = [];
      if (axis !== "x" && cuttingPlaneX.value)
        otherPlanes.push(cuttingPlaneX.value);
      if (axis !== "y" && cuttingPlaneY.value)
        otherPlanes.push(cuttingPlaneY.value);
      if (axis !== "z" && cuttingPlaneZ.value)
        otherPlanes.push(cuttingPlaneZ.value);

      const capMat = resources.capMesh.material;
      const clippingPlanesToApply = otherPlanes.length > 0 ? otherPlanes : null;

      if (Array.isArray(capMat)) {
        for (const mat of capMat) {
          mat.clippingPlanes = clippingPlanesToApply;
          mat.needsUpdate = true;
        }
      } else {
        (capMat as THREE.Material).clippingPlanes = clippingPlanesToApply;
        (capMat as THREE.Material).needsUpdate = true;
      }

      const edgeMat = (resources.edgeLines as LineSegments2)
        .material as THREE.Material;
      edgeMat.clippingPlanes = clippingPlanesToApply;
      edgeMat.needsUpdate = true;
    }
  };

  // ============================================================================
  // Drag Handlers (dot-handle only)
  // ============================================================================

  const collectDragHandles = (): THREE.Mesh[] => {
    const handles: THREE.Mesh[] = [];
    for (const groupRef of [
      cuttingPlaneMeshX,
      cuttingPlaneMeshY,
      cuttingPlaneMeshZ,
    ]) {
      const g = groupRef.value;
      if (!g || !g.visible) continue;
      g.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.isDragHandle) {
          handles.push(child);
        }
      });
    }
    return handles;
  };

  const handlePointerDown = (event: PointerEvent) => {
    const cameraVal = context.camera.value;
    if (event.button !== 0 || !cameraVal) return false;

    const handles = collectDragHandles();
    if (handles.length === 0) return false;

    const coords = getNormalizedCoords(event);
    raycaster.setFromCamera(coords, cameraVal);
    const intersects = raycaster.intersectObjects(handles, false);

    if (intersects.length > 0) {
      const hitHandle = intersects[0].object as THREE.Mesh;
      let parentGroup = hitHandle.parent;
      while (parentGroup && !parentGroup.userData.planeAxis) {
        parentGroup = parentGroup.parent;
      }
      if (!parentGroup) return false;

      draggingPlane = parentGroup.userData.planeAxis as PlaneAxis;
      dragStartPoint = intersects[0].point.clone();
      context.interaction.suppress("orbit");
      return true;
    }

    return false;
  };

  const handlePointerMove = (event: PointerEvent) => {
    const cameraVal = context.camera.value;
    if (
      !draggingPlane ||
      draggingPlane === "face" ||
      !dragStartPoint ||
      !cameraVal
    )
      return;

    const planeRef = getPlaneRef(draggingPlane);
    const meshRef = getPlaneMeshRef(draggingPlane);

    if (!planeRef.value || !meshRef.value) return;

    const coords = getNormalizedCoords(event);
    raycaster.setFromCamera(coords, cameraVal);

    const cameraDir = new THREE.Vector3();
    cameraVal.getWorldDirection(cameraDir);
    const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      cameraDir,
      dragStartPoint,
    );

    const intersection = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(dragPlane, intersection)) return;

    const axis = draggingPlane;
    const delta = intersection[axis] - dragStartPoint[axis];

    meshRef.value.position[axis] += delta;

    const normal = planeRef.value.normal;
    planeRef.value.constant = -normal.dot(meshRef.value.position);

    dragStartPoint[axis] += delta;

    // Update distance state
    updatePlaneDistance(axis);

    // Update annotation overlay
    const canvas = context.getCanvas();
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      dragAnnotation.visible = true;
      dragAnnotation.x = event.clientX - rect.left + 16;
      dragAnnotation.y = event.clientY - rect.top - 10;
      dragAnnotation.text = `${planeDistances[axis].toFixed(3)}`;
    }

    updateMaterialClipping();

    const resources = planeCapResources.get(draggingPlane);
    if (resources) {
      resources.capMesh.visible = false;
      resources.edgeLines.visible = false;
    }

    scheduleCapUpdate(draggingPlane);
  };

  const handlePointerUp = () => {
    if (draggingPlane) {
      if (capUpdateTimeoutId !== null) {
        clearTimeout(capUpdateTimeoutId);
        capUpdateTimeoutId = null;
      }
      pendingCapAxes.delete(draggingPlane);
      performCapUpdateAsync(draggingPlane);

      dragAnnotation.visible = false;

      context.interaction.consumeNextClick();

      draggingPlane = null;
      dragStartPoint = null;
      context.interaction.unsuppress("orbit");
    }
  };

  // ============================================================================
  // Public API - Toggle Functions
  // ============================================================================

  const toggleCuttingPlaneX = (
    flip: boolean = false,
    isActive: boolean = false,
  ): boolean => {
    const sceneVal = context.scene.value;
    const boundingBox = context.getModelBoundingBox();
    if (!sceneVal || !boundingBox) return false;

    if (isActive) {
      if (cuttingPlaneMeshX.value) {
        sceneVal.remove(cuttingPlaneMeshX.value);
        disposeGizmo(cuttingPlaneMeshX.value);
      }
      cuttingPlaneX.value = null;
      cuttingPlaneMeshX.value = null;
      activeCuttingPlanes.value.delete("x");
      updateMaterialClipping();
      removePlaneCapResources("x");
      return false;
    } else {
      const center = boundingBox.getCenter(new THREE.Vector3());
      const normalDir = flip ? -1 : 1;
      const normal = new THREE.Vector3(normalDir, 0, 0);

      cuttingPlaneX.value = new THREE.Plane(normal, -center.x * normalDir);
      cuttingPlaneMeshX.value = createPlaneGizmo(
        new THREE.Vector3(1, 0, 0),
        0xff4444,
      );
      cuttingPlaneMeshX.value.position.copy(center);
      cuttingPlaneMeshX.value.userData.planeAxis = "x";
      cuttingPlaneMeshX.value.visible = cuttingPlanesVisible.value;

      sceneVal.add(cuttingPlaneMeshX.value);
      activeCuttingPlanes.value.add("x");
      flipState.set("x", flip);
      updatePlaneDistance("x");
      updateMaterialClipping();
      if (cuttingPlaneX.value) {
        createPlaneCapResources("x", cuttingPlaneX.value);
      }
      return true;
    }
  };

  const toggleCuttingPlaneY = (
    flip: boolean = false,
    isActive: boolean = false,
  ): boolean => {
    const sceneVal = context.scene.value;
    const boundingBox = context.getModelBoundingBox();
    if (!sceneVal || !boundingBox) return false;

    if (isActive) {
      if (cuttingPlaneMeshY.value) {
        sceneVal.remove(cuttingPlaneMeshY.value);
        disposeGizmo(cuttingPlaneMeshY.value);
      }
      cuttingPlaneY.value = null;
      cuttingPlaneMeshY.value = null;
      activeCuttingPlanes.value.delete("y");
      updateMaterialClipping();
      removePlaneCapResources("y");
      return false;
    } else {
      const center = boundingBox.getCenter(new THREE.Vector3());
      const normalDir = flip ? -1 : 1;
      const normal = new THREE.Vector3(0, normalDir, 0);

      cuttingPlaneY.value = new THREE.Plane(normal, -center.y * normalDir);
      cuttingPlaneMeshY.value = createPlaneGizmo(
        new THREE.Vector3(0, 1, 0),
        0x44ff44,
      );
      cuttingPlaneMeshY.value.position.copy(center);
      cuttingPlaneMeshY.value.userData.planeAxis = "y";
      cuttingPlaneMeshY.value.visible = cuttingPlanesVisible.value;

      sceneVal.add(cuttingPlaneMeshY.value);
      activeCuttingPlanes.value.add("y");
      flipState.set("y", flip);
      updatePlaneDistance("y");
      updateMaterialClipping();
      if (cuttingPlaneY.value) {
        createPlaneCapResources("y", cuttingPlaneY.value);
      }
      return true;
    }
  };

  const toggleCuttingPlaneZ = (
    flip: boolean = false,
    isActive: boolean = false,
  ): boolean => {
    const sceneVal = context.scene.value;
    const boundingBox = context.getModelBoundingBox();
    if (!sceneVal || !boundingBox) return false;

    if (isActive) {
      if (cuttingPlaneMeshZ.value) {
        sceneVal.remove(cuttingPlaneMeshZ.value);
        disposeGizmo(cuttingPlaneMeshZ.value);
      }
      cuttingPlaneZ.value = null;
      cuttingPlaneMeshZ.value = null;
      activeCuttingPlanes.value.delete("z");
      updateMaterialClipping();
      removePlaneCapResources("z");
      return false;
    } else {
      const center = boundingBox.getCenter(new THREE.Vector3());
      const normalDir = flip ? -1 : 1;
      const normal = new THREE.Vector3(0, 0, normalDir);

      cuttingPlaneZ.value = new THREE.Plane(normal, -center.z * normalDir);
      cuttingPlaneMeshZ.value = createPlaneGizmo(
        new THREE.Vector3(0, 0, 1),
        0x4444ff,
      );
      cuttingPlaneMeshZ.value.position.copy(center);
      cuttingPlaneMeshZ.value.userData.planeAxis = "z";
      cuttingPlaneMeshZ.value.visible = cuttingPlanesVisible.value;

      sceneVal.add(cuttingPlaneMeshZ.value);
      activeCuttingPlanes.value.add("z");
      flipState.set("z", flip);
      updatePlaneDistance("z");
      updateMaterialClipping();
      if (cuttingPlaneZ.value) {
        createPlaneCapResources("z", cuttingPlaneZ.value);
      }
      return true;
    }
  };

  const resetCuttingPlanes = () => {
    const sceneVal = context.scene.value;
    if (!sceneVal) return;

    if (cuttingPlaneMeshX.value) {
      sceneVal.remove(cuttingPlaneMeshX.value);
      disposeGizmo(cuttingPlaneMeshX.value);
    }
    if (cuttingPlaneMeshY.value) {
      sceneVal.remove(cuttingPlaneMeshY.value);
      disposeGizmo(cuttingPlaneMeshY.value);
    }
    if (cuttingPlaneMeshZ.value) {
      sceneVal.remove(cuttingPlaneMeshZ.value);
      disposeGizmo(cuttingPlaneMeshZ.value);
    }

    cuttingPlaneX.value = null;
    cuttingPlaneY.value = null;
    cuttingPlaneZ.value = null;
    cuttingPlaneMeshX.value = null;
    cuttingPlaneMeshY.value = null;
    cuttingPlaneMeshZ.value = null;
    activeCuttingPlanes.value.clear();
    updateMaterialClipping();
    clearAllPlaneCapResources();
  };

  const hideCuttingPlanes = (hide: boolean) => {
    cuttingPlanesVisible.value = !hide;
    if (cuttingPlaneMeshX.value) cuttingPlaneMeshX.value.visible = !hide;
    if (cuttingPlaneMeshY.value) cuttingPlaneMeshY.value.visible = !hide;
    if (cuttingPlaneMeshZ.value) cuttingPlaneMeshZ.value.visible = !hide;
  };

  const setShowSectionEdges = (show: boolean) => {
    showSectionEdges.value = show;
    for (const [, resources] of planeCapResources) {
      resources.edgeLines.visible = show;
    }
  };

  const setShowSectionCaps = (show: boolean) => {
    showSectionCaps.value = show;
    for (const [axis, resources] of planeCapResources) {
      if (!show) resources.capMesh.visible = false;
      else scheduleCapUpdate(axis); // rebuild: the cap is only valid once its geometry has been computed
    }
  };

  // ============================================================================
  // Public API - State Query/Restore (NEW)
  // ============================================================================

  /**
   * Get the set of currently active plane axes.
   */
  const getActivePlanes = (): PlaneAxis[] => {
    return Array.from(activeCuttingPlanes.value);
  };

  /**
   * Get complete snapshot of current section state for save/restore.
   */
  const getSectionState = (): SectionSnapshot => {
    const planes: SectionPlaneState[] = [];

    for (const axis of activeCuttingPlanes.value) {
      if (axis === "face") continue;
      const planeRef = getPlaneRef(axis);
      const meshRef = getPlaneMeshRef(axis);
      if (planeRef.value && meshRef.value) {
        planes.push({
          axis,
          position: meshRef.value.position[axis],
          flipped: flipState.get(axis) ?? false,
        });
      }
    }

    return {
      planes,
      showEdges: showSectionEdges.value,
    };
  };

  /**
   * Restore section state from a snapshot.
   */
  const restoreSectionState = (snapshot: SectionSnapshot) => {
    // First reset all planes
    resetCuttingPlanes();

    showSectionEdges.value = snapshot.showEdges;

    // Recreate each plane from snapshot
    for (const planeState of snapshot.planes) {
      const { axis, position, flipped } = planeState;

      if (axis === "x") {
        toggleCuttingPlaneX(flipped, false);
        if (cuttingPlaneMeshX.value && cuttingPlaneX.value) {
          cuttingPlaneMeshX.value.position.x = position;
          cuttingPlaneX.value.constant = -cuttingPlaneX.value.normal.dot(
            cuttingPlaneMeshX.value.position,
          );
          updatePlaneDistance("x");
        }
      } else if (axis === "y") {
        toggleCuttingPlaneY(flipped, false);
        if (cuttingPlaneMeshY.value && cuttingPlaneY.value) {
          cuttingPlaneMeshY.value.position.y = position;
          cuttingPlaneY.value.constant = -cuttingPlaneY.value.normal.dot(
            cuttingPlaneMeshY.value.position,
          );
          updatePlaneDistance("y");
        }
      } else if (axis === "z") {
        toggleCuttingPlaneZ(flipped, false);
        if (cuttingPlaneMeshZ.value && cuttingPlaneZ.value) {
          cuttingPlaneMeshZ.value.position.z = position;
          cuttingPlaneZ.value.constant = -cuttingPlaneZ.value.normal.dot(
            cuttingPlaneMeshZ.value.position,
          );
          updatePlaneDistance("z");
        }
      }
    }

    updateMaterialClipping();
    setShowSectionEdges(snapshot.showEdges);

    // Schedule cap updates for restored planes
    for (const planeState of snapshot.planes) {
      scheduleCapUpdate(planeState.axis);
    }
  };

  /**
   * Update flip direction for an active plane without removing/re-adding.
   */
  const updateSectionFlip = (axis: PlaneAxis, flipped: boolean) => {
    const planeRef = getPlaneRef(axis);
    const meshRef = getPlaneMeshRef(axis);

    if (!planeRef.value || !meshRef.value) return;
    if (!activeCuttingPlanes.value.has(axis)) return;

    const currentFlip = flipState.get(axis) ?? false;
    if (currentFlip === flipped) return;

    // Flip the normal direction
    planeRef.value.normal.negate();
    planeRef.value.constant = -planeRef.value.constant;

    flipState.set(axis, flipped);
    updateMaterialClipping();
    updateCapClipping();

    // Recompute cap geometry with new orientation
    scheduleCapUpdate(axis);
  };

  // ============================================================================
  // Gizmo Per-Frame Update (constant-size + viewport clamping)
  // ============================================================================

  const _projVec = new THREE.Vector3();
  const _clampVec = new THREE.Vector3();

  const updateGizmos = () => {
    const cam = context.camera.value;
    if (!cam) return;

    for (const axis of ["x", "y", "z"] as PlaneAxis[]) {
      const meshRef = getPlaneMeshRef(axis);
      const group = meshRef.value;
      if (!group || !group.visible) continue;

      // Constant screen size
      const distance = cam.position.distanceTo(group.position);
      const wpp = getWorldPerPixel(distance);
      const scale = wpp * GIZMO_QUAD_PX;
      group.scale.setScalar(scale);

      // Viewport clamping: shift the gizmo's in-plane position so it stays on screen
      // while keeping the along-normal position unchanged (the clipping plane doesn't move)
      const planeRef = getPlaneRef(axis);
      if (!planeRef.value) continue;

      _projVec.copy(group.position);
      _projVec.project(cam);

      const clamped = {
        x: THREE.MathUtils.clamp(
          _projVec.x,
          -1 + GIZMO_VIEWPORT_MARGIN_NDC,
          1 - GIZMO_VIEWPORT_MARGIN_NDC,
        ),
        y: THREE.MathUtils.clamp(
          _projVec.y,
          -1 + GIZMO_VIEWPORT_MARGIN_NDC,
          1 - GIZMO_VIEWPORT_MARGIN_NDC,
        ),
      };

      if (
        Math.abs(_projVec.x - clamped.x) > 0.001 ||
        Math.abs(_projVec.y - clamped.y) > 0.001
      ) {
        _clampVec.set(clamped.x, clamped.y, _projVec.z);
        _clampVec.unproject(cam);

        // Only move in the in-plane directions, keep the along-normal position
        const normal = planeRef.value.normal;
        const diff = _clampVec.clone().sub(group.position);
        const alongNormal = diff.dot(normal);
        diff.addScaledVector(normal, -alongNormal);
        group.position.add(diff);
      }
    }
  };

  // ============================================================================
  // setPlaneDistance -- programmatically move a plane to a specific distance
  // ============================================================================

  const setPlaneDistance = (axis: PlaneAxis, distance: number) => {
    if (axis === "face") return;
    const planeRef = getPlaneRef(axis);
    const meshRef = getPlaneMeshRef(axis);
    if (!planeRef.value || !meshRef.value) return;

    meshRef.value.position[axis] = distance;
    planeRef.value.constant = -planeRef.value.normal.dot(
      meshRef.value.position,
    );
    planeDistances[axis] = distance;

    updateMaterialClipping();
    scheduleCapUpdate(axis);
  };

  // ============================================================================
  // Cleanup
  // ============================================================================

  const cleanup = () => {
    resetCuttingPlanes();

    if (capUpdateTimeoutId !== null) {
      clearTimeout(capUpdateTimeoutId);
      capUpdateTimeoutId = null;
    }
    pendingCapAxes.clear();
    draggingPlane = null;
    dragStartPoint = null;
  };

  // ============================================================================
  // Internal API (for useThreeViewer integration)
  // ============================================================================

  /**
   * Get plane refs for point visibility checking
   */
  const getPlaneRefs = () => ({
    x: cuttingPlaneX,
    y: cuttingPlaneY,
    z: cuttingPlaneZ,
  });

  /**
   * Get cap resources for raycast targets
   */
  const getCapResources = () => planeCapResources;

  /**
   * Recreate cap resources for active planes (after model reload)
   */
  const recreateCapsForActivePlanes = () => {
    for (const axis of Array.from(activeCuttingPlanes.value)) {
      const planeRef = getPlaneRef(axis);
      if (planeRef.value) {
        createPlaneCapResources(axis, planeRef.value);
      }
    }
  };

  /**
   * Refresh caps for all active cutting planes (e.g. after visibility changes).
   */
  const refreshAllCaps = () => {
    for (const axis of Array.from(planeCapResources.keys())) {
      scheduleCapUpdate(axis);
    }
  };

  // ============================================================================
  // Return Public API
  // ============================================================================

  return {
    // State (reactive)
    cuttingPlanesVisible,
    activeCuttingPlanes,
    showSectionEdges,
    showSectionCaps,
    setShowSectionCaps,
    planeDistances,
    dragAnnotation,

    // Toggle functions
    toggleCuttingPlaneX,
    toggleCuttingPlaneY,
    toggleCuttingPlaneZ,
    resetCuttingPlanes,
    hideCuttingPlanes,
    setShowSectionEdges,

    // Distance
    setPlaneDistance,

    // State query/restore
    getActivePlanes,
    getSectionState,
    restoreSectionState,
    updateSectionFlip,

    // Drag handlers
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,

    // Gizmo per-frame update
    updateGizmos,

    // Internal API
    getPlaneRefs,
    getCapResources,
    recreateCapsForActivePlanes,
    refreshAllCaps,
    updateMaterialClipping,

    // Cleanup
    cleanup,
  };
}
