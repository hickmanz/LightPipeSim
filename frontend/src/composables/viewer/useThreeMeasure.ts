/**
 * useThreeMeasure.ts
 *
 * Measurement tools for the Three.js viewer.
 * Supports point-to-point distance, edge length, and face-face angle measurements.
 * Renders labels in 3D space using CSS2DRenderer.
 */
import { ref, type Ref } from "vue";
import * as THREE from "three";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type {
  BrepEdge,
  BrepFace,
  MinDistanceResult,
  CylinderFitResult,
} from "./useBrepTopology";
import {
  fitCircle3D,
  fitCylinder3D,
  getBrepFaceTrianglePositions,
  getBrepFaceTriangleNormals,
} from "./useBrepTopology";
import {
  useBrepSelection,
  getSphereGeo,
  type BrepEntity,
  type BrepHitInfo,
  type BrepSelectionContext,
} from "./useBrepSelection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable measurement data for persistence with feedback. */
export interface MeasurementData {
  id: string;
  type:
    | "point-to-point"
    | "edge-length"
    | "face-face-angle"
    | "smart-edge-length"
    | "smart-edge-distance"
    | "smart-face-angle"
    | "smart-face-edge-distance"
    | "smart-point-distance"
    | "smart-point-edge-distance"
    | "smart-point-face-distance"
    | "smart-edge-radius"
    | "smart-face-distance"
    | "smart-cylinder-radius";
  points: Array<{ x: number; y: number; z: number }>;
  normals?: Array<{ x: number; y: number; z: number }>;
  value: number;
  unit: string;
  /** Custom label position (if the user dragged it away from the default). */
  labelPosition?: { x: number; y: number; z: number };
  /** Display variant for toggleable measurements. */
  displayMode?: "radius" | "diameter" | "angle" | "distance";
  /** Arc centers for the center/edge toggle on two-entity measurements. */
  arcCenters?: {
    a?: { x: number; y: number; z: number };
    b?: { x: number; y: number; z: number };
    axisA?: {
      origin: { x: number; y: number; z: number };
      dir: { x: number; y: number; z: number };
    };
    axisB?: {
      origin: { x: number; y: number; z: number };
      dir: { x: number; y: number; z: number };
    };
  };
  /** Whether the measurement uses arc center/axis or edge/surface closest points. */
  arcMode?: "edge" | "center";
  /** Original edge closest points, preserved so toggling back to edge mode works. */
  edgePoints?: Array<{ x: number; y: number; z: number }>;
}

export type MeasureHitInfo = BrepHitInfo;

export interface ThreeMeasureContext extends BrepSelectionContext {
  canvasEl: Ref<HTMLCanvasElement | null>;
  getBrepEdgeData?: (
    instanceNode: THREE.Object3D,
    edgeId: number,
  ) => BrepEdge | null;
  computeMinEdgeToEdgeDistance?: (
    edgeA: BrepEdge,
    edgeB: BrepEdge,
    matA: THREE.Matrix4,
    matB: THREE.Matrix4,
  ) => MinDistanceResult;
  computeMinEdgeToFaceDistance?: (
    edge: BrepEdge,
    face: BrepFace,
    edgeMat: THREE.Matrix4,
    faceMesh: THREE.Mesh,
  ) => MinDistanceResult;
}

/** Internal bookkeeping for a single rendered measurement. */
interface MeasurementVisual {
  id: string;
  data: MeasurementData;
  group: THREE.Group;
  label: CSS2DObject;
  markers: THREE.Mesh[];
  lineMaterials: LineMaterial[];
  /** Default label anchor (midpoint of the measurement geometry). */
  midpoint: THREE.Vector3;
  /** The two reference points (A and B) for dimension layout. */
  pointA: THREE.Vector3;
  pointB: THREE.Vector3;
  // -- Distance dimension layout (point-to-point, edge-length) --
  /** The solid dimension line (A' → B'); moves with offset. */
  dimensionLine: THREE.Line | null;
  /** Extension line from point A to offset A'. */
  extensionLine1: THREE.Line | null;
  /** Extension line from point B to offset B'. */
  extensionLine2: THREE.Line | null;
  // -- Angle leader (face-face-angle) --
  /** Thin leader line from midpoint to placed label. */
  leaderLine: THREE.Line | null;
  /** Plane used to constrain label drag (derived from measurement geometry). */
  constraintPlane: THREE.Plane | null;
  // -- Radius/diameter callout rotation data --
  calloutGroup?: THREE.Group;
  arcCenter?: THREE.Vector3;
  arcRadius?: number;
  circleNormal?: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEASURE_COLOR = 0x00bfff; // Cyan
const NORMAL_INDICATOR_COLOR = 0xff9900; // Orange
const MARKER_SCREEN_PX = 8;
const CLICK_THRESHOLD_PX = 5;

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useThreeMeasure(context: ThreeMeasureContext) {
  // ---- BREP selection composable -----------------------------------------
  const selection = useBrepSelection(context);
  const {
    resolveEntity,
    clearHighlights,
    createFaceHighlight,
    createPointHighlight,
    worldPerPixel,
    getRendererResolution,
  } = selection;

  // ---- Reactive state exposed to the view --------------------------------
  const activeMeasureType = ref<string | null>(null);

  /** Info about the currently active/preview/selected measurement, for the panel UI. */
  const currentMeasureInfo = ref<{
    type: string | null;
    value: number | null;
    displayMode: string | null;
    id: string | null;
    arcCenters?: MeasurementData["arcCenters"];
    arcMode?: string | null;
  }>({ type: null, value: null, displayMode: null, id: null });

  /** ID of a committed measurement that the user selected for editing. */
  const selectedMeasurementId = ref<string | null>(null);

  // ---- Internal state ----------------------------------------------------
  const measurements: MeasurementVisual[] = [];
  let pendingMarkers: THREE.Mesh[] = [];
  let pointerDownPos: { x: number; y: number } | null = null;
  let middleDownPos: { x: number; y: number } | null = null;
  let measureIdCounter = 0;
  let previousCursor = "";

  // CSS2DRenderer (lazy-initialised on first use)
  let css2dRenderer: CSS2DRenderer | null = null;

  // Callback fired after a measurement is created (used to auto-deactivate)
  let onCreatedCallback: (() => void) | null = null;

  // All LineMaterials created by measurements (kept for resolution updates)
  const allLineMaterials = new Set<LineMaterial>();

  // Label-placement phase state
  let pendingPlacement: MeasurementVisual | null = null;
  let placementRefPoint: THREE.Vector3 | null = null; // view-plane anchor

  // -----------------------------------------------------------------------
  // CSS2DRenderer management
  // -----------------------------------------------------------------------

  const initCSS2DRenderer = () => {
    if (css2dRenderer) return;
    const canvas = context.canvasEl.value;
    if (!canvas) return;

    css2dRenderer = new CSS2DRenderer();
    const container = canvas.parentElement;
    const width = container?.clientWidth ?? canvas.clientWidth;
    const height = container?.clientHeight ?? canvas.clientHeight;
    css2dRenderer.setSize(width, height);

    const el = css2dRenderer.domElement;
    el.style.position = "absolute";
    el.style.top = "0";
    el.style.left = "0";
    el.style.pointerEvents = "none";
    el.style.zIndex = "1";
    el.classList.add("measure-css2d-overlay");

    if (container) {
      // Ensure the container is a positioning context
      container.style.position = "relative";
      container.appendChild(el);
    }
  };

  /** Call every frame from the animation loop (after main scene render). */
  const render = () => {
    if (!css2dRenderer || !context.scene.value || !context.camera.value) return;
    if (
      measurements.length === 0 &&
      pendingMarkers.length === 0 &&
      !pendingPlacement
    )
      return;

    updateAllMarkerScales();
    // Also scale markers on the measurement being placed
    if (pendingPlacement) {
      for (const marker of pendingPlacement.markers) updateMarkerScale(marker);
    }
    css2dRenderer.render(context.scene.value, context.camera.value);
  };

  /** Call on canvas resize. */
  const resize = (width: number, height: number) => {
    css2dRenderer?.setSize(width, height);
    for (const mat of allLineMaterials) {
      mat.resolution.set(width, height);
    }
  };

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const updateMarkerScale = (marker: THREE.Mesh) => {
    const cam = context.camera.value;
    if (!cam) return;
    const wp = new THREE.Vector3();
    marker.getWorldPosition(wp);
    const dist = cam.position.distanceTo(wp);
    const wpp = worldPerPixel(dist);
    const s = MARKER_SCREEN_PX * wpp;
    marker.scale.set(s, s, s);
  };

  const updateAllMarkerScales = () => {
    for (const m of pendingMarkers) updateMarkerScale(m);
    for (const meas of measurements) {
      for (const marker of meas.markers) updateMarkerScale(marker);
    }
  };

  const createMarkerSphere = (position: THREE.Vector3): THREE.Mesh => {
    const mat = new THREE.MeshBasicMaterial({
      color: MEASURE_COLOR,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(getSphereGeo(), mat);
    mesh.position.copy(position);
    mesh.renderOrder = 999;
    updateMarkerScale(mesh);
    return mesh;
  };

  const createDashedLine = (
    p1: THREE.Vector3,
    p2: THREE.Vector3,
  ): THREE.Line => {
    const dist = p1.distanceTo(p2);
    const geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const mat = new THREE.LineDashedMaterial({
      color: MEASURE_COLOR,
      dashSize: Math.max(dist * 0.04, 0.0005),
      gapSize: Math.max(dist * 0.02, 0.00025),
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    line.renderOrder = 998;
    return line;
  };

  const createLabel = (text: string, position: THREE.Vector3): CSS2DObject => {
    const div = document.createElement("div");
    Object.assign(div.style, {
      background: "rgba(0, 0, 0, 0.78)",
      color: "#fff",
      padding: "3px 8px",
      borderRadius: "4px",
      fontSize: "12px",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: "500",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      userSelect: "none",
      border: "1px solid rgba(0, 191, 255, 0.5)",
      textShadow: "0 1px 2px rgba(0,0,0,0.6)",
      letterSpacing: "0.02em",
    });
    div.textContent = text;

    const label = new CSS2DObject(div);
    label.position.copy(position);
    // Offset the label so it sits above the midpoint, not on top of the line
    label.center.set(0.5, 1.4);
    return label;
  };

  const formatDistance = (d: number): string => {
    if (d < 0.001) return `${(d * 1000).toFixed(3)} \u00B5m`;
    if (d < 1) return `${d.toFixed(3)}`;
    if (d < 100) return `${d.toFixed(2)}`;
    return `${d.toFixed(1)}`;
  };

  const formatAngle = (deg: number): string => `${deg.toFixed(1)}\u00B0`;

  // -----------------------------------------------------------------------
  // CAD-style arrowhead & arc snippet helpers
  // -----------------------------------------------------------------------

  const _coneGeo = new THREE.ConeGeometry(1, 2.4, 12);
  _coneGeo.translate(0, -1.2, 0);
  _coneGeo.rotateX(Math.PI / 2);

  /**
   * Small cone arrowhead pointing along `direction`, tip at `tip`.
   * Size is in world units; caller should set a sensible size relative to
   * camera distance / measurement scale.
   */
  const createArrowhead = (
    tip: THREE.Vector3,
    direction: THREE.Vector3,
    size: number,
    color: number = MEASURE_COLOR,
  ): THREE.Mesh => {
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(_coneGeo, mat);
    mesh.scale.setScalar(size);
    mesh.position.copy(tip);
    const dir = direction.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    mesh.renderOrder = 999;
    return mesh;
  };

  /**
   * Generate a polyline arc in 3D, centred on `center` with given radius,
   * spanning `halfSpanDeg` on each side of `contactAngle` (radians) in the
   * circle's plane (defined by `normal`).
   */
  const createArcSnippet = (
    center: THREE.Vector3,
    radius: number,
    normal: THREE.Vector3,
    contactAngle: number,
    halfSpanDeg: number = 15,
    color: number = MEASURE_COLOR,
  ): THREE.Line => {
    const n = normal.clone().normalize();
    const seed =
      Math.abs(n.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    const uAxis = new THREE.Vector3().crossVectors(n, seed).normalize();
    const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

    const halfSpan = (halfSpanDeg * Math.PI) / 180;
    const segments = 24;
    const startAngle = contactAngle - halfSpan;
    const endAngle = contactAngle + halfSpan;
    const step = (endAngle - startAngle) / segments;

    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = startAngle + step * i;
      points.push(
        center
          .clone()
          .addScaledVector(uAxis, Math.cos(a) * radius)
          .addScaledVector(vAxis, Math.sin(a) * radius),
      );
    }

    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 998;
    return line;
  };

  /**
   * Compute the angle (radians) of `point` relative to `center` in the
   * circle's local 2D frame (uAxis, vAxis derived from `normal`).
   */
  const computeContactAngle = (
    point: THREE.Vector3,
    center: THREE.Vector3,
    normal: THREE.Vector3,
  ): { angle: number; uAxis: THREE.Vector3; vAxis: THREE.Vector3 } => {
    const n = normal.clone().normalize();
    const seed =
      Math.abs(n.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    const uAxis = new THREE.Vector3().crossVectors(n, seed).normalize();
    const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();
    const d = new THREE.Vector3().subVectors(point, center);
    return { angle: Math.atan2(d.dot(vAxis), d.dot(uAxis)), uAxis, vAxis };
  };

  // -----------------------------------------------------------------------
  // Dimension layout helpers
  // -----------------------------------------------------------------------

  /**
  /** Create a thin solid line between two points. */
  const createSolidLine = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number = MEASURE_COLOR,
    opacity: number = 0.8,
  ): THREE.Line => {
    const geom = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity,
    });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 997;
    return line;
  };

  /** Update an existing two-point line's endpoints in-place. */
  const updateLinePositions = (
    line: THREE.Line,
    from: THREE.Vector3,
    to: THREE.Vector3,
  ) => {
    const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
  };

  // -----------------------------------------------------------------------
  // Measurement creation
  // -----------------------------------------------------------------------

  const createPointToPointVisual = (
    p1: THREE.Vector3,
    p2: THREE.Vector3,
  ): MeasurementVisual => {
    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const distance = p1.distanceTo(p2);
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);

    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    // Markers at the actual measurement points
    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    // Dimension line (initially between A and B; moves when placed)
    const dimLine = createSolidLine(p1, p2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    // Label at midpoint of dimension line
    const label = createLabel(formatDistance(distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    return {
      id,
      data: {
        id,
        type: "point-to-point",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        value: distance,
        unit: "mm",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [],
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: null,
    };
  };

  const createFaceAngleVisual = (
    p1: THREE.Vector3,
    n1: THREE.Vector3,
    p2: THREE.Vector3,
    n2: THREE.Vector3,
  ): MeasurementVisual => {
    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const dot = THREE.MathUtils.clamp(n1.dot(n2), -1, 1);
    const angleDeg = THREE.MathUtils.radToDeg(Math.acos(dot));
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);

    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    const measLineMats: LineMaterial[] = [];

    // Markers at both face hit points
    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    // Normal direction indicators (short lines from hit points along normals)
    const normalLen = Math.max(p1.distanceTo(p2) * 0.25, 0.01);
    const [rw, rh] = getRendererResolution();

    for (const [origin, normal] of [
      [p1, n1],
      [p2, n2],
    ] as [THREE.Vector3, THREE.Vector3][]) {
      const end = origin.clone().addScaledVector(normal, normalLen);
      const geo = new LineSegmentsGeometry();
      geo.setPositions([origin.x, origin.y, origin.z, end.x, end.y, end.z]);
      const mat = new LineMaterial({
        color: NORMAL_INDICATOR_COLOR,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.8,
      });
      mat.resolution.set(rw, rh);
      allLineMaterials.add(mat);
      measLineMats.push(mat);
      const fl = new LineSegments2(geo, mat);
      fl.renderOrder = 998;
      group.add(fl);
    }

    // Connecting dashed line between the two face hits
    group.add(createDashedLine(p1, p2));

    // Angle label
    const label = createLabel(formatAngle(angleDeg), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    return {
      id,
      data: {
        id,
        type: "face-face-angle",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        normals: [
          { x: n1.x, y: n1.y, z: n1.z },
          { x: n2.x, y: n2.y, z: n2.z },
        ],
        value: angleDeg,
        unit: "deg",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: measLineMats,
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: null,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
        n1.clone().add(n2).normalize().lengthSq() > 1e-10
          ? n1.clone().add(n2).normalize()
          : n1,
        midpoint,
      ),
    };
  };

  // -----------------------------------------------------------------------
  // Label placement phase
  // -----------------------------------------------------------------------

  /** Is this a distance measurement (dimension-line style placement)? */
  const isDimensionType = (visual: MeasurementVisual): boolean =>
    visual.data.type === "point-to-point" ||
    visual.data.type === "edge-length" ||
    visual.data.type === "smart-edge-length" ||
    visual.data.type === "smart-edge-distance" ||
    visual.data.type === "smart-face-edge-distance" ||
    visual.data.type === "smart-point-distance" ||
    visual.data.type === "smart-point-edge-distance" ||
    visual.data.type === "smart-point-face-distance" ||
    visual.data.type === "smart-face-distance";

  /** Is this a radius/diameter callout (rotational placement)? */
  const isRadiusType = (visual: MeasurementVisual): boolean =>
    visual.data.type === "smart-edge-radius" ||
    visual.data.type === "smart-cylinder-radius";

  /**
   * Enter label-placement mode for the just-created visual.
   * The dimension line / label follows the cursor until the user clicks.
   */
  const enterPlacementMode = (visual: MeasurementVisual) => {
    pendingPlacement = visual;
    placementRefPoint = visual.midpoint.clone();

    if (isRadiusType(visual)) {
      // Radius/diameter: no extra extension lines needed;
      // placement rotates the callout around the circle axis.
    } else if (isDimensionType(visual)) {
      // Distance: extension lines + leader for text placement
      const ext1 = createSolidLine(
        visual.pointA,
        visual.pointA,
        MEASURE_COLOR,
        0.45,
      );
      const ext2 = createSolidLine(
        visual.pointB,
        visual.pointB,
        MEASURE_COLOR,
        0.45,
      );
      const leader = createSolidLine(
        visual.midpoint,
        visual.midpoint,
        MEASURE_COLOR,
        0.9,
      );
      visual.extensionLine1 = ext1;
      visual.extensionLine2 = ext2;
      visual.leaderLine = leader;
      visual.group.add(ext1, ext2, leader);
    } else {
      // Angle: leader line from midpoint (current style)
      const leader = createSolidLine(
        visual.midpoint,
        visual.midpoint,
        MEASURE_COLOR,
        0.45,
      );
      visual.leaderLine = leader;
      visual.group.add(leader);
    }

    // Switch cursor to indicate placement
    const canvas = context.canvasEl.value;
    if (canvas) canvas.style.cursor = "move";

    updateMeasureInfo(visual);
  };

  /**
   * Get the constraint plane for label drag. Uses the pre-computed plane
   * stored on the visual (derived from the adjacent face normal at pick time),
   * falling back to a view-aligned plane through the midpoint.
   */
  const computeMeasurePlane = (visual: MeasurementVisual): THREE.Plane => {
    if (visual.constraintPlane) return visual.constraintPlane;

    // Fallback: view-aligned plane through the midpoint
    const cam = context.camera.value;
    const viewDir = cam
      ? new THREE.Vector3()
          .subVectors(cam.position, visual.midpoint)
          .normalize()
      : new THREE.Vector3(0, 0, 1);
    return new THREE.Plane().setFromNormalAndCoplanarPoint(
      viewDir,
      visual.midpoint,
    );
  };

  /** Project cursor onto the measurement constraint plane. */
  const cursorToConstrainedPlane = (
    event: PointerEvent,
    plane: THREE.Plane,
  ): THREE.Vector3 | null => {
    const cam = context.camera.value;
    const rend = context.renderer.value;
    if (!cam || !rend) return null;
    const rect = rend.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    const result = new THREE.Vector3();
    if (!rc.ray.intersectPlane(plane, result)) return null;
    return result;
  };

  /**
   * Helper to dispose all children of a THREE.Group (geometry + material),
   * then remove them from the group.
   */
  const disposeGroupChildren = (g: THREE.Group) => {
    const kids = [...g.children];
    for (const child of kids) {
      g.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry?.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      }
    }
  };

  /** Move the pending dimension / label to follow the cursor. */
  const updatePlacementPosition = (event: PointerEvent) => {
    if (!pendingPlacement || !placementRefPoint) return;
    const plane = computeMeasurePlane(pendingPlacement);
    const worldPos = cursorToConstrainedPlane(event, plane);
    if (!worldPos) return;

    if (isRadiusType(pendingPlacement)) {
      // ---- Radius/Diameter: rotate callout around circle axis + control leader length ----
      const ctr = pendingPlacement.arcCenter;
      const rad = pendingPlacement.arcRadius;
      const norm = pendingPlacement.circleNormal;
      const cg = pendingPlacement.calloutGroup;
      if (!ctr || !rad || !norm || !cg) return;

      // Project cursor onto circle plane to get radial direction + distance
      const cursorVec = worldPos.clone().sub(ctr);
      const alongAxis = cursorVec.dot(norm);
      cursorVec.addScaledVector(norm, -alongAxis);
      const cursorDistFromCenter = cursorVec.length();
      if (cursorDistFromCenter < 1e-10) return;
      const newRadialDir = cursorVec.clone().normalize();

      // Rebuild the callout geometry in the new orientation
      disposeGroupChildren(cg);
      cg.parent?.remove(cg);

      const isDiam = pendingPlacement.data.displayMode === "diameter";
      if (isDiam) {
        const callout = buildDiameterCallout(
          pendingPlacement.group,
          ctr,
          rad,
          norm,
          newRadialDir,
          cursorDistFromCenter,
        );
        pendingPlacement.calloutGroup = callout.calloutGroup;
        pendingPlacement.midpoint.copy(callout.leaderTip);
        pendingPlacement.markers = callout.markers;
        pendingPlacement.label.position.copy(callout.leaderTip);
      } else {
        const callout = buildRadiusCallout(
          pendingPlacement.group,
          ctr,
          rad,
          norm,
          newRadialDir,
          cursorDistFromCenter,
        );
        pendingPlacement.calloutGroup = callout.calloutGroup;
        pendingPlacement.midpoint.copy(callout.leaderTip);
        pendingPlacement.markers = callout.markers;
        pendingPlacement.label.position.copy(callout.leaderTip);
      }

      // Update stored edge point for serialisation
      const newArcPt = ctr.clone().addScaledVector(newRadialDir, rad);
      pendingPlacement.pointB.copy(newArcPt);
      if (pendingPlacement.data.points.length >= 2) {
        pendingPlacement.data.points[1] = {
          x: newArcPt.x,
          y: newArcPt.y,
          z: newArcPt.z,
        };
      }
    } else if (isDimensionType(pendingPlacement)) {
      // ---- Distance: offset dim line perpendicularly + leader for text ----
      const pA = pendingPlacement.pointA;
      const pB = pendingPlacement.pointB;
      const mid = pA.clone().add(pB).multiplyScalar(0.5);
      const abDir = new THREE.Vector3().subVectors(pB, pA);
      const abLen = abDir.length();
      if (abLen < 1e-10) return;
      abDir.normalize();

      // Decompose cursor offset into perpendicular + lateral
      const toTarget = worldPos.clone().sub(mid);
      const lateral = toTarget.dot(abDir);
      const perpOffset = toTarget.clone().addScaledVector(abDir, -lateral);

      const aPrime = pA.clone().add(perpOffset);
      const bPrime = pB.clone().add(perpOffset);

      // Move the dimension line
      if (pendingPlacement.dimensionLine) {
        updateLinePositions(pendingPlacement.dimensionLine, aPrime, bPrime);
      }

      // Stretch extension lines from actual points to offset endpoints
      if (pendingPlacement.extensionLine1) {
        updateLinePositions(pendingPlacement.extensionLine1, pA, aPrime);
      }
      if (pendingPlacement.extensionLine2) {
        updateLinePositions(pendingPlacement.extensionLine2, pB, bPrime);
      }

      // Text position: project cursor onto dim-line direction at the offset level.
      // If cursor is beyond the A'-B' segment, extend a leader from the nearest end.
      const projOnDim = worldPos.clone().sub(aPrime).dot(abDir);
      const textPos = aPrime.clone().addScaledVector(abDir, projOnDim);

      if (pendingPlacement.leaderLine) {
        if (projOnDim < 0) {
          updateLinePositions(pendingPlacement.leaderLine, aPrime, textPos);
        } else if (projOnDim > abLen) {
          updateLinePositions(pendingPlacement.leaderLine, bPrime, textPos);
        } else {
          // Inside segment: no leader visible
          updateLinePositions(pendingPlacement.leaderLine, textPos, textPos);
        }
      }

      pendingPlacement.label.position.copy(textPos);
    } else {
      // ---- Angle: move label freely, update leader line ----
      pendingPlacement.label.position.copy(worldPos);
      if (pendingPlacement.leaderLine) {
        updateLinePositions(
          pendingPlacement.leaderLine,
          pendingPlacement.midpoint,
          worldPos,
        );
      }
    }
  };

  /** Finalise the placement, commit the measurement, and fire callback. */
  const finalizePlacement = () => {
    if (!pendingPlacement) return;

    const labelPos = pendingPlacement.label.position;
    const mid = pendingPlacement.midpoint;

    // Check if the dimension was barely moved
    const movedDist = labelPos.distanceTo(mid);
    const cam = context.camera.value;
    const threshold = cam ? worldPerPixel(cam.position.distanceTo(mid)) * 6 : 0;

    if (isRadiusType(pendingPlacement)) {
      // Radius callout: always keep current orientation (label position
      // is already at the leader tip / midpoint from the rotation logic).
      pendingPlacement.data.labelPosition = {
        x: labelPos.x,
        y: labelPos.y,
        z: labelPos.z,
      };
    } else if (movedDist < threshold) {
      // ---- Snap back to default (no offset) ----
      pendingPlacement.label.position.copy(mid);

      if (isDimensionType(pendingPlacement)) {
        // Reset dimension line back to original points
        if (pendingPlacement.dimensionLine) {
          updateLinePositions(
            pendingPlacement.dimensionLine,
            pendingPlacement.pointA,
            pendingPlacement.pointB,
          );
        }
        removeLineFromVisual(pendingPlacement, "extensionLine1");
        removeLineFromVisual(pendingPlacement, "extensionLine2");
        removeLineFromVisual(pendingPlacement, "leaderLine");
      } else {
        removeLineFromVisual(pendingPlacement, "leaderLine");
      }
    } else {
      // ---- Keep the custom position ----
      pendingPlacement.data.labelPosition = {
        x: labelPos.x,
        y: labelPos.y,
        z: labelPos.z,
      };
    }

    // Commit
    measurements.push(pendingPlacement);
    pendingPlacement = null;
    placementRefPoint = null;
    resetPending();
    resetSmartState();

    // Restore crosshair cursor (will be fully reset when operator deactivates)
    const canvas = context.canvasEl.value;
    if (canvas) canvas.style.cursor = "crosshair";

    onCreatedCallback?.();
  };

  /** Dispose a single optional line field on a visual. */
  const removeLineFromVisual = (
    visual: MeasurementVisual,
    key: "extensionLine1" | "extensionLine2" | "leaderLine",
  ) => {
    const line = visual[key];
    if (!line) return;
    visual.group.remove(line);
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
    visual[key] = null;
  };

  /** Cancel in-progress label placement (removes the uncommitted visual). */
  const cancelPlacement = () => {
    if (!pendingPlacement) return;
    disposeMeasurement(pendingPlacement);
    pendingPlacement = null;
    placementRefPoint = null;
  };

  // -----------------------------------------------------------------------
  // SmartMeasure – entity types and state
  // -----------------------------------------------------------------------

  type SmartState = "idle" | "first_picked" | "preview";
  let smartState: SmartState = "idle";
  let smartEntity1: BrepEntity | null = null;
  let smartEntity1Visual: THREE.Group | null = null;
  let smartEntity1CylinderFit: CylinderFitResult | null = null;

  function clearBrepEntity1Visual(): void {
    if (smartEntity1Visual) {
      context.scene.value?.remove(smartEntity1Visual);
      smartEntity1Visual.traverse((child) => {
        const m = child as any;
        if (m.geometry && m.geometry !== getSphereGeo()) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material))
            m.material.forEach((mm: THREE.Material) => mm.dispose());
          else m.material.dispose();
        }
      });
      smartEntity1Visual = null;
    }
  }

  function createSmartEdgeLengthVisual(
    entity: BrepEntity & { kind: "edge" },
  ): MeasurementVisual | null {
    if (!context.getBrepEdgeWorldPositions) return null;
    const worldSegs = context.getBrepEdgeWorldPositions(
      entity.instanceNode,
      entity.edgeId,
    );
    if (!worldSegs || worldSegs.length === 0) return null;

    // Detect circular edges: fit a circle to the world-space polyline points
    const worldPts: THREE.Vector3[] = [worldSegs[0][0].clone()];
    for (const [, b] of worldSegs) worldPts.push(b.clone());
    const circleFit = fitCircle3D(worldPts);
    if (circleFit) {
      return createSmartEdgeRadiusVisual(
        entity,
        worldSegs,
        circleFit.radius,
        circleFit.center,
        circleFit.normal,
      );
    }

    const first = worldSegs[0][0];
    const last = worldSegs[worldSegs.length - 1][1];
    const midpoint = first.clone().add(last).multiplyScalar(0.5);

    // Compute world-space total length (accounts for non-uniform scaling)
    let worldTotalLength = 0;
    for (const [a, b] of worldSegs) {
      worldTotalLength += a.distanceTo(b);
    }

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    // Fat-line for the full BREP edge
    const positions: number[] = [];
    for (const [a, b] of worldSegs) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(positions);
    const [rw, rh] = getRendererResolution();
    const lineMat = new LineMaterial({
      color: MEASURE_COLOR,
      linewidth: 3,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    lineMat.resolution.set(rw, rh);
    allLineMaterials.add(lineMat);
    const fatLine = new LineSegments2(lineGeo, lineMat);
    fatLine.renderOrder = 998;
    group.add(fatLine);

    // Markers at edge endpoints
    const m1 = createMarkerSphere(first);
    const m2 = createMarkerSphere(last);
    group.add(m1, m2);

    // Dimension line
    const dimLine = createSolidLine(first, last, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    // Label
    const label = createLabel(formatDistance(worldTotalLength), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    return {
      id,
      data: {
        id,
        type: "smart-edge-length",
        points: [
          { x: first.x, y: first.y, z: first.z },
          { x: last.x, y: last.y, z: last.z },
        ],
        value: worldTotalLength,
        unit: "mm",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [lineMat],
      midpoint: midpoint.clone(),
      pointA: first.clone(),
      pointB: last.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: constraintPlaneFromEntity(entity, midpoint),
    };
  }

  /**
   * Build the CAD-style radius callout geometry inside a sub-group.
   * Layout: center dot → line to arc surface (arrow at arc) → leader
   * extending outward past the arc where the dimension text sits.
   * The sub-group is added to `group` and can be rotated around the
   * circle axis for placement.
   */
  function buildRadiusCallout(
    group: THREE.Group,
    center: THREE.Vector3,
    radius: number,
    circleNormal: THREE.Vector3,
    radialDir: THREE.Vector3,
    leaderTipDist?: number,
  ) {
    const calloutGroup = new THREE.Group();
    group.add(calloutGroup);

    const arcPt = center.clone().addScaledVector(radialDir, radius);
    const tipDist = Math.max(radius * 1.15, leaderTipDist ?? radius * 1.5);
    const leaderTip = center.clone().addScaledVector(radialDir, tipDist);

    const cam = context.camera.value;
    const arrowSize = cam
      ? worldPerPixel(cam.position.distanceTo(center)) * 3.5
      : radius * 0.035;

    // Line from center to arc surface
    const centerToArc = createSolidLine(center, arcPt, MEASURE_COLOR, 0.9);
    calloutGroup.add(centerToArc);

    // Leader line extending outward from arc point
    const leaderLine = createSolidLine(arcPt, leaderTip, MEASURE_COLOR, 0.9);
    calloutGroup.add(leaderLine);

    // Arrowhead at the arc contact point (inside, tip touching arc)
    calloutGroup.add(createArrowhead(arcPt, radialDir, arrowSize));

    // Arc snippet (~30 deg total) at the contact point
    const { angle: contactAngle } = computeContactAngle(
      arcPt,
      center,
      circleNormal,
    );
    calloutGroup.add(
      createArcSnippet(center, radius, circleNormal, contactAngle, 15),
    );

    // Center marker (small cross-point)
    const centerMarker = createMarkerSphere(center);
    calloutGroup.add(centerMarker);

    return {
      calloutGroup,
      centerToArc,
      leaderLine,
      arcPt,
      leaderTip,
      midpoint: leaderTip.clone(),
      markers: [centerMarker],
    };
  }

  /**
   * Build the CAD-style diameter callout geometry inside a sub-group.
   * Full diametral line with arrows on both ends pointing inward,
   * arc snippets on both sides, and a leader extending outward from
   * arcPt1 where the text sits.
   */
  function buildDiameterCallout(
    group: THREE.Group,
    center: THREE.Vector3,
    radius: number,
    circleNormal: THREE.Vector3,
    radialDir: THREE.Vector3,
    leaderTipDist?: number,
  ) {
    const calloutGroup = new THREE.Group();
    group.add(calloutGroup);

    const arcPt1 = center.clone().addScaledVector(radialDir, radius);
    const arcPt2 = center.clone().addScaledVector(radialDir, -radius);

    // Leader extends outward from arcPt1
    const tipDist = Math.max(radius * 1.15, leaderTipDist ?? radius * 1.5);
    const leaderTip = center.clone().addScaledVector(radialDir, tipDist);

    const cam = context.camera.value;
    const arrowSize = cam
      ? worldPerPixel(cam.position.distanceTo(center)) * 3.5
      : radius * 0.035;

    // Full diametral line
    const dimLine = createSolidLine(arcPt2, arcPt1, MEASURE_COLOR, 0.9);
    calloutGroup.add(dimLine);

    // Leader line from arcPt1 outward
    const leaderLine = createSolidLine(arcPt1, leaderTip, MEASURE_COLOR, 0.9);
    calloutGroup.add(leaderLine);

    // Arrowheads at both ends (inside, tips touching arc)
    const negDir = radialDir.clone().negate();
    calloutGroup.add(createArrowhead(arcPt1, radialDir, arrowSize));
    calloutGroup.add(createArrowhead(arcPt2, negDir, arrowSize));

    // Arc snippets at both contact points
    const { angle: angle1 } = computeContactAngle(arcPt1, center, circleNormal);
    calloutGroup.add(
      createArcSnippet(center, radius, circleNormal, angle1, 15),
    );
    const { angle: angle2 } = computeContactAngle(arcPt2, center, circleNormal);
    calloutGroup.add(
      createArcSnippet(center, radius, circleNormal, angle2, 15),
    );

    // Center marker
    const centerMarker = createMarkerSphere(center);
    calloutGroup.add(centerMarker);

    return {
      calloutGroup,
      dimLine,
      leaderLine,
      arcPt1,
      arcPt2,
      leaderTip,
      midpoint: leaderTip.clone(),
      markers: [centerMarker],
    };
  }

  function createSmartEdgeRadiusVisual(
    _entity: BrepEntity & { kind: "edge" },
    worldSegs: [THREE.Vector3, THREE.Vector3][],
    radius: number,
    center: THREE.Vector3,
    circleNormal?: THREE.Vector3,
  ): MeasurementVisual | null {
    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    // Fat-line for the full BREP edge
    const positions: number[] = [];
    for (const [a, b] of worldSegs) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(positions);
    const [rw, rh] = getRendererResolution();
    const lineMat = new LineMaterial({
      color: MEASURE_COLOR,
      linewidth: 3,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    lineMat.resolution.set(rw, rh);
    allLineMaterials.add(lineMat);
    const fatLine = new LineSegments2(lineGeo, lineMat);
    fatLine.renderOrder = 998;
    group.add(fatLine);

    // Pick the edge point closest to the true radius for the radial direction
    let edgePoint = worldSegs[0][0].clone();
    let bestDist = Infinity;
    for (const [a, b] of worldSegs) {
      for (const p of [a, b]) {
        const d = Math.abs(p.distanceTo(center) - radius);
        if (d < bestDist) {
          bestDist = d;
          edgePoint = p.clone();
        }
      }
    }

    const radialDir = edgePoint.clone().sub(center).normalize();
    const n = circleNormal ?? new THREE.Vector3(0, 1, 0);

    const callout = buildRadiusCallout(group, center, radius, n, radialDir);

    // Label
    const label = createLabel(`R ${formatDistance(radius)}`, callout.midpoint);
    group.add(label);

    context.scene.value!.add(group);

    const cPlane = circleNormal
      ? new THREE.Plane().setFromNormalAndCoplanarPoint(
          circleNormal,
          callout.midpoint,
        )
      : null;

    return {
      id,
      data: {
        id,
        type: "smart-edge-radius",
        points: [
          { x: center.x, y: center.y, z: center.z },
          { x: edgePoint.x, y: edgePoint.y, z: edgePoint.z },
        ],
        normals: circleNormal
          ? [{ x: circleNormal.x, y: circleNormal.y, z: circleNormal.z }]
          : undefined,
        value: radius,
        unit: "mm",
        displayMode: "radius",
      },
      group,
      label,
      markers: callout.markers,
      lineMaterials: [lineMat],
      midpoint: callout.midpoint.clone(),
      pointA: center.clone(),
      pointB: callout.arcPt.clone(),
      dimensionLine: null,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: cPlane,
      calloutGroup: callout.calloutGroup,
      arcCenter: center.clone(),
      arcRadius: radius,
      circleNormal: n.clone(),
    };
  }

  function createSmartCylinderRadiusVisual(
    faceEntity: BrepEntity & { kind: "face" },
    cylFit: CylinderFitResult,
  ): MeasurementVisual | null {
    const { center, axis, radius } = cylFit;

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    // Face highlight overlay
    const faceHL = createFaceHighlight(faceEntity, MEASURE_COLOR);
    if (faceHL) group.add(faceHL);

    // Axis segment: project face hit point onto axis to determine visible range.
    // Approximate extents by projecting face positions.
    const facePositions = getBrepFaceTrianglePositions(
      faceEntity.mesh,
      faceEntity.faceId,
    );
    let axisMin = 0,
      axisMax = 0;
    if (facePositions) {
      let first = true;
      for (let i = 0; i < facePositions.length / 3; i++) {
        const wp = new THREE.Vector3(
          facePositions[i * 3],
          facePositions[i * 3 + 1],
          facePositions[i * 3 + 2],
        ).applyMatrix4(faceEntity.mesh.matrixWorld);
        const t = wp.clone().sub(center).dot(axis);
        if (first) {
          axisMin = t;
          axisMax = t;
          first = false;
        } else {
          axisMin = Math.min(axisMin, t);
          axisMax = Math.max(axisMax, t);
        }
      }
    }
    const axisA = center.clone().addScaledVector(axis, axisMin);
    const axisB = center.clone().addScaledVector(axis, axisMax);
    group.add(createDashedLine(axisA, axisB));

    // Radial direction: from axis to hit point (perpendicular to axis)
    const hitVec = faceEntity.hitPoint.clone().sub(center);
    const hitAlongAxis = hitVec.dot(axis);
    const axisPoint = center.clone().addScaledVector(axis, hitAlongAxis);
    let radialDir = faceEntity.hitPoint.clone().sub(axisPoint);
    if (radialDir.lengthSq() < 1e-10) {
      // Hit is on the axis; pick an arbitrary perpendicular
      const seed =
        Math.abs(axis.x) < 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0);
      radialDir = new THREE.Vector3().crossVectors(axis, seed);
    }
    radialDir.normalize();

    const surfPt = axisPoint.clone().addScaledVector(radialDir, radius);

    // Use axis as the circle normal for the callout helpers
    const callout = buildRadiusCallout(
      group,
      axisPoint,
      radius,
      axis,
      radialDir,
    );

    const label = createLabel(`R ${formatDistance(radius)}`, callout.midpoint);
    group.add(label);

    context.scene.value!.add(group);

    const cPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      axis,
      callout.midpoint,
    );

    return {
      id,
      data: {
        id,
        type: "smart-cylinder-radius" as MeasurementData["type"],
        points: [
          { x: axisPoint.x, y: axisPoint.y, z: axisPoint.z },
          { x: surfPt.x, y: surfPt.y, z: surfPt.z },
        ],
        normals: [{ x: axis.x, y: axis.y, z: axis.z }],
        value: radius,
        unit: "mm",
        displayMode: "radius",
      },
      group,
      label,
      markers: callout.markers,
      lineMaterials: [],
      midpoint: callout.midpoint.clone(),
      pointA: axisPoint.clone(),
      pointB: callout.arcPt.clone(),
      dimensionLine: null,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: cPlane,
      calloutGroup: callout.calloutGroup,
      arcCenter: axisPoint.clone(),
      arcRadius: radius,
      circleNormal: axis.clone(),
    };
  }

  function createSmartEdgeDistanceVisual(
    e1: BrepEntity & { kind: "edge" },
    e2: BrepEntity & { kind: "edge" },
  ): MeasurementVisual | null {
    if (
      !context.computeMinEdgeToEdgeDistance ||
      !context.getBrepEdgeWorldPositions
    )
      return null;

    const result = context.computeMinEdgeToEdgeDistance(
      e1.edge,
      e2.edge,
      e1.instanceNode.matrixWorld,
      e2.instanceNode.matrixWorld,
    );

    const p1 = result.pointOnA;
    const p2 = result.pointOnB;
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    const measLineMats: LineMaterial[] = [];

    // Highlight both edges
    for (const entity of [e1, e2]) {
      const worldSegs = context.getBrepEdgeWorldPositions(
        entity.instanceNode,
        entity.edgeId,
      );
      if (worldSegs) {
        const positions: number[] = [];
        for (const [a, b] of worldSegs) {
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        const lineGeo = new LineSegmentsGeometry();
        lineGeo.setPositions(positions);
        const [rw, rh] = getRendererResolution();
        const lineMat = new LineMaterial({
          color: MEASURE_COLOR,
          linewidth: 3,
          depthTest: false,
          transparent: true,
          opacity: 0.7,
        });
        lineMat.resolution.set(rw, rh);
        allLineMaterials.add(lineMat);
        measLineMats.push(lineMat);
        const fl = new LineSegments2(lineGeo, lineMat);
        fl.renderOrder = 998;
        group.add(fl);
      }
    }

    // Markers at closest approach points
    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    // Dimension line
    const dimLine = createSolidLine(p1, p2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    // Label
    const label = createLabel(formatDistance(result.distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    // Detect circular edges for center/edge toggle
    const arcCenters: MeasurementData["arcCenters"] = {};
    for (const [entity, key] of [
      [e1, "a"],
      [e2, "b"],
    ] as const) {
      const worldSegs = context.getBrepEdgeWorldPositions(
        entity.instanceNode,
        entity.edgeId,
      );
      if (worldSegs) {
        const worldPts: THREE.Vector3[] = [worldSegs[0][0].clone()];
        for (const [, b] of worldSegs) worldPts.push(b.clone());
        const fit = fitCircle3D(worldPts);
        if (fit) {
          arcCenters[key] = {
            x: fit.center.x,
            y: fit.center.y,
            z: fit.center.z,
          };
        }
      }
    }
    const hasArcCenters = arcCenters.a != null || arcCenters.b != null;

    return {
      id,
      data: {
        id,
        type: "smart-edge-distance",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        value: result.distance,
        unit: "mm",
        ...(hasArcCenters
          ? {
              arcCenters,
              arcMode: "edge" as const,
              edgePoints: [
                { x: p1.x, y: p1.y, z: p1.z },
                { x: p2.x, y: p2.y, z: p2.z },
              ],
            }
          : {}),
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: measLineMats,
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: constraintPlaneFromEntity(e1, midpoint),
    };
  }

  function createSmartFaceAngleVisual(
    f1: BrepEntity & { kind: "face" },
    f2: BrepEntity & { kind: "face" },
  ): MeasurementVisual {
    const visual = createFaceAngleVisual(
      f1.hitPoint,
      f1.normal,
      f2.hitPoint,
      f2.normal,
    );
    visual.data.displayMode = "angle";
    return visual;
  }

  function createSmartFaceDistanceVisual(
    p1: THREE.Vector3,
    n1: THREE.Vector3,
    p2: THREE.Vector3,
    _n2: THREE.Vector3,
  ): MeasurementVisual {
    const toP2 = p2.clone().sub(p1);
    const signedDist = toP2.dot(n1);
    const normalDist = Math.abs(signedDist);

    // foot2 = the point directly above/below p1 along n1 at the
    // perpendicular distance.  The dim line p1→foot2 is always
    // exactly along the face normal so the leaders stay parallel.
    const foot2 = p1.clone().addScaledVector(n1, signedDist);
    const midpoint = p1.clone().add(foot2).multiplyScalar(0.5);

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(foot2);
    group.add(m1, m2);

    const dimLine = createSolidLine(p1, foot2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    // Dashed witness from the actual face-2 hit to the foot of the
    // perpendicular so the user can see the connection to where they clicked.
    if (p2.distanceTo(foot2) > 1e-6) {
      group.add(createDashedLine(p2, foot2));
    }

    const label = createLabel(formatDistance(normalDist), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    return {
      id,
      data: {
        id,
        type: "smart-face-distance",
        // Original face hit points preserved for toggling back to angle
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        normals: [
          { x: n1.x, y: n1.y, z: n1.z },
          { x: _n2.x, y: _n2.y, z: _n2.z },
        ],
        value: normalDist,
        unit: "mm",
        displayMode: "distance",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [],
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: foot2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
        n1,
        midpoint,
      ),
    };
  }

  function createSmartFaceEdgeDistanceVisual(
    face: BrepEntity & { kind: "face" },
    edge: BrepEntity & { kind: "edge" },
  ): MeasurementVisual | null {
    if (
      !context.computeMinEdgeToFaceDistance ||
      !context.getBrepFaceData ||
      !context.getBrepEdgeWorldPositions
    )
      return null;

    const faceData = context.getBrepFaceData(face.mesh, face.faceId);
    if (!faceData) return null;

    const result = context.computeMinEdgeToFaceDistance(
      edge.edge,
      faceData,
      edge.instanceNode.matrixWorld,
      face.mesh,
    );

    const p1 = result.pointOnA;
    const p2 = result.pointOnB;
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    const measLineMats: LineMaterial[] = [];

    // Highlight the edge
    const worldSegs = context.getBrepEdgeWorldPositions(
      edge.instanceNode,
      edge.edgeId,
    );
    if (worldSegs) {
      const positions: number[] = [];
      for (const [a, b] of worldSegs) {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const lineGeo = new LineSegmentsGeometry();
      lineGeo.setPositions(positions);
      const [rw, rh] = getRendererResolution();
      const lineMat = new LineMaterial({
        color: MEASURE_COLOR,
        linewidth: 3,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
      });
      lineMat.resolution.set(rw, rh);
      allLineMaterials.add(lineMat);
      measLineMats.push(lineMat);
      const fl = new LineSegments2(lineGeo, lineMat);
      fl.renderOrder = 998;
      group.add(fl);
    }

    // Markers
    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    // Dimension line
    const dimLine = createSolidLine(p1, p2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    // Label
    const label = createLabel(formatDistance(result.distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    // Detect circular edge and cylinder face for center/edge toggle
    const arcCenters: MeasurementData["arcCenters"] = {};
    if (worldSegs) {
      const worldPts: THREE.Vector3[] = [worldSegs[0][0].clone()];
      for (const [, b] of worldSegs) worldPts.push(b.clone());
      const fit = fitCircle3D(worldPts);
      if (fit)
        arcCenters.b = { x: fit.center.x, y: fit.center.y, z: fit.center.z };
    }
    // Check if face is a cylinder
    const facePosArr = getBrepFaceTrianglePositions(face.mesh, face.faceId);
    const faceNrmArr = getBrepFaceTriangleNormals(face.mesh, face.faceId);
    if (facePosArr && faceNrmArr) {
      const cylFit = fitCylinder3D(facePosArr, faceNrmArr);
      if (cylFit) {
        const c = cylFit.center.clone().applyMatrix4(face.mesh.matrixWorld);
        const d = cylFit.axis
          .clone()
          .transformDirection(face.mesh.matrixWorld)
          .normalize();
        arcCenters.axisA = {
          origin: { x: c.x, y: c.y, z: c.z },
          dir: { x: d.x, y: d.y, z: d.z },
        };
      }
    }
    const hasArcCenters =
      arcCenters.a != null || arcCenters.b != null || arcCenters.axisA != null;

    return {
      id,
      data: {
        id,
        type: "smart-face-edge-distance",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        value: result.distance,
        unit: "mm",
        ...(hasArcCenters
          ? {
              arcCenters,
              arcMode: "edge" as const,
              edgePoints: [
                { x: p1.x, y: p1.y, z: p1.z },
                { x: p2.x, y: p2.y, z: p2.z },
              ],
            }
          : {}),
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: measLineMats,
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: constraintPlaneFromEntity(face, midpoint),
    };
  }

  function createSmartPointDistanceVisual(
    p1Entity: BrepEntity & { kind: "point" },
    p2Entity: BrepEntity & { kind: "point" },
  ): MeasurementVisual {
    const p1 = p1Entity.worldPoint;
    const p2 = p2Entity.worldPoint;
    const visual = createPointToPointVisual(p1, p2);
    visual.data.type = "smart-point-distance";
    visual.constraintPlane = constraintPlaneFromEntity(
      p1Entity,
      visual.midpoint,
    );
    return visual;
  }

  function createSmartPointEdgeDistanceVisual(
    pointEntity: BrepEntity & { kind: "point" },
    edgeEntity: BrepEntity & { kind: "edge" },
  ): MeasurementVisual | null {
    if (!context.getBrepEdgeWorldPositions) return null;
    const worldSegs = context.getBrepEdgeWorldPositions(
      edgeEntity.instanceNode,
      edgeEntity.edgeId,
    );
    if (!worldSegs || worldSegs.length === 0) return null;

    const pt = pointEntity.worldPoint;
    let bestDist = Infinity;
    let bestClosest = pt.clone();
    const _seg = new THREE.Vector3();
    const _toPoint = new THREE.Vector3();

    for (const [a, b] of worldSegs) {
      _seg.subVectors(b, a);
      const segLen = _seg.length();
      if (segLen < 1e-10) continue;
      _seg.normalize();
      _toPoint.subVectors(pt, a);
      const t = Math.max(0, Math.min(segLen, _toPoint.dot(_seg)));
      const proj = a.clone().addScaledVector(_seg, t);
      const d = pt.distanceTo(proj);
      if (d < bestDist) {
        bestDist = d;
        bestClosest = proj;
      }
    }

    const p1 = pt.clone();
    const p2 = bestClosest;
    const distance = p1.distanceTo(p2);
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);
    const id = `measure-${++measureIdCounter}-${Date.now()}`;

    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    const dimLine = createSolidLine(p1, p2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    const label = createLabel(formatDistance(distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    // Detect circular edge for center/edge toggle
    const arcCenters: MeasurementData["arcCenters"] = {};
    const worldPts: THREE.Vector3[] = [worldSegs[0][0].clone()];
    for (const [, b] of worldSegs) worldPts.push(b.clone());
    const fit = fitCircle3D(worldPts);
    if (fit)
      arcCenters.b = { x: fit.center.x, y: fit.center.y, z: fit.center.z };
    const hasArcCenters = arcCenters.b != null;

    return {
      id,
      data: {
        id,
        type: "smart-point-edge-distance",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        value: distance,
        unit: "mm",
        ...(hasArcCenters
          ? {
              arcCenters,
              arcMode: "edge" as const,
              edgePoints: [
                { x: p1.x, y: p1.y, z: p1.z },
                { x: p2.x, y: p2.y, z: p2.z },
              ],
            }
          : {}),
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [],
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: constraintPlaneFromEntity(edgeEntity, midpoint),
    };
  }

  function createSmartPointFaceDistanceVisual(
    pointEntity: BrepEntity & { kind: "point" },
    faceEntity: BrepEntity & { kind: "face" },
  ): MeasurementVisual | null {
    if (!context.getBrepFaceData) return null;
    const faceData = context.getBrepFaceData(
      faceEntity.mesh,
      faceEntity.faceId,
    );
    if (!faceData) return null;

    const pt = pointEntity.worldPoint;
    const worldNormal = faceData.normal
      .clone()
      .transformDirection(faceEntity.mesh.matrixWorld)
      .normalize();
    const worldCentroid = faceData.centroid
      .clone()
      .applyMatrix4(faceEntity.mesh.matrixWorld);

    // Project point onto face plane along normal
    const toPoint = pt.clone().sub(worldCentroid);
    const signedDist = toPoint.dot(worldNormal);
    const projected = pt.clone().addScaledVector(worldNormal, -signedDist);

    const p1 = pt.clone();
    const p2 = projected;
    const distance = Math.abs(signedDist);
    const midpoint = p1.clone().add(p2).multiplyScalar(0.5);
    const id = `measure-${++measureIdCounter}-${Date.now()}`;

    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    const m1 = createMarkerSphere(p1);
    const m2 = createMarkerSphere(p2);
    group.add(m1, m2);

    const dimLine = createSolidLine(p1, p2, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    const label = createLabel(formatDistance(distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    return {
      id,
      data: {
        id,
        type: "smart-point-face-distance",
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        normals: [{ x: worldNormal.x, y: worldNormal.y, z: worldNormal.z }],
        value: distance,
        unit: "mm",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [],
      midpoint: midpoint.clone(),
      pointA: p1.clone(),
      pointB: p2.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
        worldNormal,
        midpoint,
      ),
    };
  }

  // -----------------------------------------------------------------------
  // Constraint plane from entity face normals
  // -----------------------------------------------------------------------

  function constraintPlaneFromEntity(
    entity: BrepEntity,
    midpoint: THREE.Vector3,
  ): THREE.Plane | null {
    let normal: THREE.Vector3 | null = null;
    if (entity.kind === "face") {
      normal = entity.normal.clone();
    } else if (entity.kind === "edge") {
      normal = entity.hitFaceNormal.clone();
    } else if (entity.kind === "point" && entity.hitFaceNormal) {
      normal = entity.hitFaceNormal.clone();
    }
    if (!normal || normal.lengthSq() < 1e-10) return null;
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, midpoint);
  }

  // -----------------------------------------------------------------------
  // Toggle functions (radius/diameter, angle/distance)
  // -----------------------------------------------------------------------

  function toggleRadiusDiameter(visual: MeasurementVisual): void {
    const switchToDiameter = visual.data.displayMode !== "diameter";
    const pts = visual.data.points;
    const norms = visual.data.normals;
    if (pts.length < 2) return;

    const center = new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);
    const edgePt = new THREE.Vector3(pts[1].x, pts[1].y, pts[1].z);
    const circleNormal =
      norms && norms.length > 0
        ? new THREE.Vector3(norms[0].x, norms[0].y, norms[0].z)
        : new THREE.Vector3(0, 1, 0);
    const storedRadius = switchToDiameter
      ? visual.data.value
      : visual.data.value / 2;
    const radialDir = edgePt.clone().sub(center).normalize();

    const savedLabelPos = visual.data.labelPosition;
    const savedType = visual.data.type;

    // Preserve fat-line LineMaterials from the edge highlight so they
    // aren't disposed (they belong to the edge, not the callout).
    // disposeMeasurement will remove all, so we rebuild them.
    disposeMeasurement(visual);

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    let newVisual: MeasurementVisual;

    if (switchToDiameter) {
      const callout = buildDiameterCallout(
        group,
        center,
        storedRadius,
        circleNormal,
        radialDir,
      );
      const label = createLabel(
        `\u2300 ${formatDistance(storedRadius * 2)}`,
        callout.leaderTip,
      );
      group.add(label);
      context.scene.value!.add(group);

      newVisual = {
        id,
        data: {
          id,
          type: savedType,
          points: pts,
          normals: norms,
          value: storedRadius * 2,
          unit: "mm",
          displayMode: "diameter",
        },
        group,
        label,
        markers: callout.markers,
        lineMaterials: [],
        midpoint: callout.leaderTip.clone(),
        pointA: center.clone(),
        pointB: callout.arcPt1.clone(),
        dimensionLine: null,
        extensionLine1: null,
        extensionLine2: null,
        leaderLine: null,
        constraintPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
          circleNormal,
          callout.leaderTip,
        ),
        calloutGroup: callout.calloutGroup,
        arcCenter: center.clone(),
        arcRadius: storedRadius,
        circleNormal: circleNormal.clone(),
      };
    } else {
      const callout = buildRadiusCallout(
        group,
        center,
        storedRadius,
        circleNormal,
        radialDir,
      );
      const label = createLabel(
        `R ${formatDistance(storedRadius)}`,
        callout.midpoint,
      );
      group.add(label);
      context.scene.value!.add(group);

      newVisual = {
        id,
        data: {
          id,
          type: savedType,
          points: pts,
          normals: norms,
          value: storedRadius,
          unit: "mm",
          displayMode: "radius",
        },
        group,
        label,
        markers: callout.markers,
        lineMaterials: [],
        midpoint: callout.midpoint.clone(),
        pointA: center.clone(),
        pointB: callout.arcPt.clone(),
        dimensionLine: null,
        extensionLine1: null,
        extensionLine2: null,
        leaderLine: null,
        constraintPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(
          circleNormal,
          callout.midpoint,
        ),
        calloutGroup: callout.calloutGroup,
        arcCenter: center.clone(),
        arcRadius: storedRadius,
        circleNormal: circleNormal.clone(),
      };
    }

    if (savedLabelPos) {
      newVisual.data.labelPosition = savedLabelPos;
      applyLabelPosition(newVisual, newVisual.data);
    }

    if (pendingPlacement === visual) {
      enterPlacementMode(newVisual);
    } else {
      const idx = measurements.indexOf(visual);
      if (idx >= 0) measurements[idx] = newVisual;
    }
    updateMeasureInfo(newVisual);
  }

  function toggleAngleDistance(visual: MeasurementVisual): void {
    if (!visual.data.normals || visual.data.normals.length < 2) return;
    if (visual.data.points.length < 2) return;

    const p1 = new THREE.Vector3(
      visual.data.points[0].x,
      visual.data.points[0].y,
      visual.data.points[0].z,
    );
    const p2 = new THREE.Vector3(
      visual.data.points[1].x,
      visual.data.points[1].y,
      visual.data.points[1].z,
    );
    const n1 = new THREE.Vector3(
      visual.data.normals[0].x,
      visual.data.normals[0].y,
      visual.data.normals[0].z,
    );
    const n2 = new THREE.Vector3(
      visual.data.normals[1].x,
      visual.data.normals[1].y,
      visual.data.normals[1].z,
    );

    const savedLabelPos = visual.data.labelPosition;

    disposeMeasurement(visual);

    const isAngle = visual.data.displayMode !== "distance";
    let newVisual: MeasurementVisual;

    if (isAngle) {
      newVisual = createSmartFaceDistanceVisual(p1, n1, p2, n2);
    } else {
      newVisual = createFaceAngleVisual(p1, n1, p2, n2);
      newVisual.data.type = "smart-face-angle";
      newVisual.data.displayMode = "angle";
      newVisual.data.normals = [
        { x: n1.x, y: n1.y, z: n1.z },
        { x: n2.x, y: n2.y, z: n2.z },
      ];
    }

    if (savedLabelPos) {
      newVisual.data.labelPosition = savedLabelPos;
      applyLabelPosition(newVisual, newVisual.data);
    }

    // Replace in the measurements list or pendingPlacement
    if (pendingPlacement === visual) {
      // Re-enter placement mode so extension / leader lines are created
      enterPlacementMode(newVisual);
    } else {
      const idx = measurements.indexOf(visual);
      if (idx >= 0) measurements[idx] = newVisual;
    }
    updateMeasureInfo(newVisual);
  }

  /**
   * Toggle between measuring from arc centers/cylinder axes vs. edge/surface
   * closest points.  Disposes and rebuilds the visual with the new endpoints.
   */
  function toggleCenterEdge(visual: MeasurementVisual): void {
    const ac = visual.data.arcCenters;
    if (!ac) return;

    const switchToCenter = visual.data.arcMode !== "center";
    const pts = visual.data.points;
    const edgePts = visual.data.edgePoints ?? pts;
    if (pts.length < 2) return;

    let newA: THREE.Vector3;
    let newB: THREE.Vector3;

    if (switchToCenter) {
      // Resolve point A
      if (ac.a) {
        newA = new THREE.Vector3(ac.a.x, ac.a.y, ac.a.z);
      } else if (ac.axisA) {
        const origin = new THREE.Vector3(
          ac.axisA.origin.x,
          ac.axisA.origin.y,
          ac.axisA.origin.z,
        );
        const dir = new THREE.Vector3(
          ac.axisA.dir.x,
          ac.axisA.dir.y,
          ac.axisA.dir.z,
        ).normalize();
        const refB = ac.b
          ? new THREE.Vector3(ac.b.x, ac.b.y, ac.b.z)
          : new THREE.Vector3(pts[1].x, pts[1].y, pts[1].z);
        const t = refB.clone().sub(origin).dot(dir);
        newA = origin.addScaledVector(dir, t);
      } else {
        newA = new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);
      }

      // Resolve point B
      if (ac.b) {
        newB = new THREE.Vector3(ac.b.x, ac.b.y, ac.b.z);
      } else if (ac.axisB) {
        const origin = new THREE.Vector3(
          ac.axisB.origin.x,
          ac.axisB.origin.y,
          ac.axisB.origin.z,
        );
        const dir = new THREE.Vector3(
          ac.axisB.dir.x,
          ac.axisB.dir.y,
          ac.axisB.dir.z,
        ).normalize();
        const t = newA.clone().sub(origin).dot(dir);
        newB = origin.addScaledVector(dir, t);
      } else {
        newB = new THREE.Vector3(pts[1].x, pts[1].y, pts[1].z);
      }
    } else {
      newA = new THREE.Vector3(edgePts[0].x, edgePts[0].y, edgePts[0].z);
      newB = new THREE.Vector3(edgePts[1].x, edgePts[1].y, edgePts[1].z);
    }

    const distance = newA.distanceTo(newB);
    const midpoint = newA.clone().add(newB).multiplyScalar(0.5);
    const savedLabelPos = visual.data.labelPosition;
    const savedData = { ...visual.data };

    disposeMeasurement(visual);

    const id = `measure-${++measureIdCounter}-${Date.now()}`;
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    const m1 = createMarkerSphere(newA);
    const m2 = createMarkerSphere(newB);
    group.add(m1, m2);

    const dimLine = createSolidLine(newA, newB, MEASURE_COLOR, 0.9);
    group.add(dimLine);

    const label = createLabel(formatDistance(distance), midpoint);
    group.add(label);

    context.scene.value!.add(group);

    const newVisual: MeasurementVisual = {
      id,
      data: {
        ...savedData,
        id,
        points: [
          { x: newA.x, y: newA.y, z: newA.z },
          { x: newB.x, y: newB.y, z: newB.z },
        ],
        value: distance,
        arcMode: switchToCenter ? "center" : "edge",
      },
      group,
      label,
      markers: [m1, m2],
      lineMaterials: [],
      midpoint: midpoint.clone(),
      pointA: newA.clone(),
      pointB: newB.clone(),
      dimensionLine: dimLine,
      extensionLine1: null,
      extensionLine2: null,
      leaderLine: null,
      constraintPlane: visual.constraintPlane,
    };

    if (savedLabelPos) {
      newVisual.data.labelPosition = savedLabelPos;
      applyLabelPosition(newVisual, newVisual.data);
    }

    if (pendingPlacement === visual) {
      enterPlacementMode(newVisual);
    } else {
      const idx = measurements.indexOf(visual);
      if (idx >= 0) measurements[idx] = newVisual;
    }
    updateMeasureInfo(newVisual);
  }

  /** Toggle the pending (preview) measurement's display mode. */
  function togglePendingMode(): void {
    if (!pendingPlacement) return;
    const t = pendingPlacement.data.type;
    if (
      t === "smart-edge-radius" ||
      t === "smart-cylinder-radius" ||
      pendingPlacement.data.displayMode === "diameter"
    ) {
      toggleRadiusDiameter(pendingPlacement);
    } else if (t === "smart-face-angle" || t === "smart-face-distance") {
      toggleAngleDistance(pendingPlacement);
    }
  }

  /** Toggle a committed measurement's display mode by ID. */
  function toggleMeasurementMode(measurementId: string): void {
    const visual = measurements.find((m) => m.id === measurementId);
    if (!visual) return;
    const t = visual.data.type;
    if (
      t === "smart-edge-radius" ||
      t === "smart-cylinder-radius" ||
      visual.data.displayMode === "diameter"
    ) {
      toggleRadiusDiameter(visual);
    } else if (t === "smart-face-angle" || t === "smart-face-distance") {
      toggleAngleDistance(visual);
    }
  }

  /** Toggle center/edge for the pending measurement. */
  function toggleCenterEdgePending(): void {
    if (!pendingPlacement) return;
    if (pendingPlacement.data.arcCenters) toggleCenterEdge(pendingPlacement);
  }

  /** Toggle center/edge for a committed measurement by ID. */
  function toggleCenterEdgeById(measurementId: string): void {
    const visual = measurements.find((m) => m.id === measurementId);
    if (!visual) return;
    if (visual.data.arcCenters) toggleCenterEdge(visual);
  }

  function isSameEntity(a: BrepEntity | null, b: BrepEntity): boolean {
    if (!a) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === "edge" && b.kind === "edge") {
      return a.instanceNode === b.instanceNode && a.edgeId === b.edgeId;
    }
    if (a.kind === "face" && b.kind === "face") {
      return a.mesh === b.mesh && a.faceId === b.faceId;
    }
    return false;
  }

  function createTwoEntityVisual(
    e1: BrepEntity,
    e2: BrepEntity,
  ): MeasurementVisual | null {
    if (e1.kind === "point" && e2.kind === "point") {
      return createSmartPointDistanceVisual(e1, e2);
    } else if (e1.kind === "point" && e2.kind === "edge") {
      return createSmartPointEdgeDistanceVisual(e1, e2);
    } else if (e1.kind === "edge" && e2.kind === "point") {
      return createSmartPointEdgeDistanceVisual(e2, e1);
    } else if (e1.kind === "point" && e2.kind === "face") {
      return createSmartPointFaceDistanceVisual(e1, e2);
    } else if (e1.kind === "face" && e2.kind === "point") {
      return createSmartPointFaceDistanceVisual(e2, e1);
    } else if (e1.kind === "edge" && e2.kind === "edge") {
      return createSmartEdgeDistanceVisual(e1, e2);
    } else if (e1.kind === "face" && e2.kind === "face") {
      const faceVisual = createSmartFaceAngleVisual(e1, e2);
      faceVisual.data.type = "smart-face-angle";
      return faceVisual;
    } else if (e1.kind === "face" && e2.kind === "edge") {
      return createSmartFaceEdgeDistanceVisual(e1, e2);
    } else if (e1.kind === "edge" && e2.kind === "face") {
      return createSmartFaceEdgeDistanceVisual(e2, e1);
    }
    return null;
  }

  function replacePreviewWithTwoEntity(entity2: BrepEntity): void {
    if (!smartEntity1 || !pendingPlacement) return;

    if (isSameEntity(smartEntity1, entity2)) {
      finalizePlacement();
      return;
    }

    disposeMeasurement(pendingPlacement);
    pendingPlacement = null;
    placementRefPoint = null;

    const visual = createTwoEntityVisual(smartEntity1, entity2);
    if (!visual) return;

    clearHighlights();
    enterPlacementMode(visual);
    const canvas = context.canvasEl.value;
    if (canvas) canvas.style.cursor = "crosshair";
  }

  function processSmartClick(hitInfo: MeasureHitInfo): void {
    const entity = resolveEntity(hitInfo);
    if (!entity) return;

    if (smartState === "idle") {
      smartEntity1 = entity;
      clearHighlights();

      if (entity.kind === "edge") {
        // Edge first pick: immediately show edge length/radius preview
        const visual = createSmartEdgeLengthVisual(entity);
        if (visual) {
          smartState = "preview";
          enterPlacementMode(visual);
          const canvas = context.canvasEl.value;
          if (canvas) canvas.style.cursor = "crosshair";
        } else {
          resetSmartState();
        }
      } else {
        // Face or point: show locked highlight, wait for second pick
        smartState = "first_picked";
        smartEntity1CylinderFit = null;
        const group = new THREE.Group();
        let highlight: THREE.Object3D | null;
        if (entity.kind === "point") {
          highlight = createPointHighlight(entity, MEASURE_COLOR);
          const marker = createMarkerSphere(entity.worldPoint);
          group.add(marker);
          pendingMarkers.push(marker);
        } else {
          highlight = createFaceHighlight(entity, MEASURE_COLOR);
          const marker = createMarkerSphere(entity.hitPoint);
          group.add(marker);
          pendingMarkers.push(marker);

          // Detect cylindrical surface
          const facePositions = getBrepFaceTrianglePositions(
            entity.mesh,
            entity.faceId,
          );
          const faceNormals = getBrepFaceTriangleNormals(
            entity.mesh,
            entity.faceId,
          );
          if (facePositions && faceNormals) {
            const cylFit = fitCylinder3D(facePositions, faceNormals);
            if (cylFit) {
              // Transform to world space (center, axis, and radius)
              const worldScale = new THREE.Vector3();
              entity.mesh.matrixWorld.decompose(
                new THREE.Vector3(),
                new THREE.Quaternion(),
                worldScale,
              );
              cylFit.center.applyMatrix4(entity.mesh.matrixWorld);
              cylFit.axis
                .transformDirection(entity.mesh.matrixWorld)
                .normalize();
              cylFit.radius *= (worldScale.x + worldScale.y + worldScale.z) / 3;
              smartEntity1CylinderFit = cylFit;
            }
          }
        }
        if (highlight) group.add(highlight);
        context.scene.value?.add(group);
        smartEntity1Visual = group;
      }
    } else if (smartState === "first_picked" && smartEntity1) {
      // Second pick from face/point first pick
      const visual = createTwoEntityVisual(smartEntity1, entity);
      if (visual) {
        clearHighlights();
        clearBrepEntity1Visual();
        clearPendingMarkers();
        smartState = "preview";
        enterPlacementMode(visual);
        const canvas = context.canvasEl.value;
        if (canvas) canvas.style.cursor = "crosshair";
      }
    } else if (smartState === "preview") {
      replacePreviewWithTwoEntity(entity);
    }
  }

  function resetSmartState(): void {
    smartState = "idle";
    smartEntity1 = null;
    smartEntity1CylinderFit = null;
    clearBrepEntity1Visual();
    clearHighlights();
    clearPendingMarkers();
    updateMeasureInfo();
  }

  function updateMeasureInfo(visual?: MeasurementVisual | null): void {
    const v = visual ?? pendingPlacement;
    if (v) {
      currentMeasureInfo.value = {
        type: v.data.type,
        value: v.data.value,
        displayMode: v.data.displayMode ?? null,
        id: v.id,
        arcCenters: v.data.arcCenters,
        arcMode: v.data.arcMode ?? null,
      };
    } else if (selectedMeasurementId.value) {
      const sel = measurements.find(
        (m) => m.id === selectedMeasurementId.value,
      );
      if (sel) {
        currentMeasureInfo.value = {
          type: sel.data.type,
          value: sel.data.value,
          displayMode: sel.data.displayMode ?? null,
          id: sel.id,
          arcCenters: sel.data.arcCenters,
          arcMode: sel.data.arcMode ?? null,
        };
        return;
      }
      currentMeasureInfo.value = {
        type: null,
        value: null,
        displayMode: null,
        id: null,
      };
    } else {
      currentMeasureInfo.value = {
        type: null,
        value: null,
        displayMode: null,
        id: null,
      };
    }
  }

  function selectMeasurement(id: string | null): void {
    selectedMeasurementId.value = id;
    updateMeasureInfo();
  }

  function handleSmartKeyDown(event: KeyboardEvent): void {
    if (activeMeasureType.value !== "SmartMeasure") return;

    if (event.key === "Escape") {
      if (smartState === "preview" && pendingPlacement) {
        cancelPlacement();
        resetSmartState();
        return;
      }
      if (
        smartState === "first_picked" &&
        smartEntity1 &&
        confirmCylinderRadius()
      ) {
        return;
      }
      resetSmartState();
    }
  }

  /**
   * If the first picked entity is a face with a detected cylinder,
   * create and display the cylinder radius visual. Returns true if handled.
   */
  function confirmCylinderRadius(): boolean {
    if (
      !smartEntity1 ||
      smartEntity1.kind !== "face" ||
      !smartEntity1CylinderFit
    )
      return false;

    clearBrepEntity1Visual();
    clearPendingMarkers();

    const visual = createSmartCylinderRadiusVisual(
      smartEntity1,
      smartEntity1CylinderFit,
    );
    if (!visual) return false;

    smartState = "preview";
    enterPlacementMode(visual);
    const canvas = context.canvasEl.value;
    if (canvas) canvas.style.cursor = "crosshair";
    return true;
  }

  // -----------------------------------------------------------------------
  // Measurement click processing
  // -----------------------------------------------------------------------

  function findMeasurementAtScreenPos(
    event: PointerEvent,
  ): MeasurementVisual | null {
    const rend = context.renderer.value;
    const cam = context.camera.value;
    if (!rend || !cam) return null;

    const rect = rend.domElement.getBoundingClientRect();
    const LABEL_HIT_PX = 30;

    for (const m of measurements) {
      const screenPos = m.label.position.clone().project(cam);
      const sx = (screenPos.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-screenPos.y * 0.5 + 0.5) * rect.height + rect.top;
      const dx = event.clientX - sx;
      const dy = event.clientY - sy;
      if (Math.sqrt(dx * dx + dy * dy) < LABEL_HIT_PX) return m;
    }
    return null;
  }

  const processMeasurementClick = (hitInfo: MeasureHitInfo) => {
    if (activeMeasureType.value === "SmartMeasure") {
      processSmartClick(hitInfo);
    }
  };

  // -----------------------------------------------------------------------
  // Pointer event handlers
  // -----------------------------------------------------------------------

  const onPointerDown = (event: PointerEvent) => {
    if (!activeMeasureType.value) return;

    // Middle click: record position for confirm-vs-orbit detection on pointerup,
    // but never block propagation here so orbit always starts
    if (event.button === 1) {
      middleDownPos = { x: event.clientX, y: event.clientY };
      return;
    }

    // Let right clicks through for pan
    if (event.button !== 0) return;

    // Left-click: consume so it doesn't start an orbit via CadOrbitControls
    event.stopPropagation();
    event.preventDefault();
    pointerDownPos = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!activeMeasureType.value) return;

    // Middle click (button 1): if short click, finalize placement or confirm cylinder
    if (event.button === 1) {
      if (!middleDownPos) return;
      const dx = event.clientX - middleDownPos.x;
      const dy = event.clientY - middleDownPos.y;
      middleDownPos = null;
      if (Math.sqrt(dx * dx + dy * dy) >= CLICK_THRESHOLD_PX) return;
      if (pendingPlacement) {
        finalizePlacement();
      } else if (smartState === "first_picked" && smartEntity1) {
        confirmCylinderRadius();
      }
      return;
    }

    if (!pointerDownPos) return;

    if (event.button !== 0) return;

    // Left-click: always consume to prevent part selection
    event.stopPropagation();
    event.preventDefault();

    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    const dragDist = Math.sqrt(dx * dx + dy * dy);
    pointerDownPos = null;

    if (dragDist >= CLICK_THRESHOLD_PX) return;

    // In preview state: clicking an entity replaces the measurement,
    // clicking empty space finalizes placement
    if (smartState === "preview" && pendingPlacement) {
      const hitInfo = context.getHitInfo(event);
      if (hitInfo) {
        const entity = resolveEntity(hitInfo);
        if (entity) {
          replacePreviewWithTwoEntity(entity);
          return;
        }
      }
      finalizePlacement();
      return;
    }

    const hitInfo = context.getHitInfo(event);
    if (!hitInfo) {
      // No geometry hit: try selecting an existing measurement label
      if (smartState === "idle" && measurements.length > 0) {
        const hitMeas = findMeasurementAtScreenPos(event);
        if (hitMeas) {
          selectMeasurement(hitMeas.id);
          return;
        }
      }
      selectMeasurement(null);
      return;
    }

    // Clicking geometry clears any label selection
    selectMeasurement(null);
    processMeasurementClick(hitInfo);
  };

  /** Track cursor during label-placement and entity hover. */
  const onPointerMove = (event: PointerEvent) => {
    if (activeMeasureType.value !== "SmartMeasure") return;

    // In preview: update label position AND highlight potential second picks
    if (smartState === "preview" && pendingPlacement) {
      updatePlacementPosition(event);
      selection.handleHover(event);
      return;
    }

    // Idle or first_picked: just hover for entity highlighting
    selection.handleHover(event);
  };

  // -----------------------------------------------------------------------
  // Pending state management
  // -----------------------------------------------------------------------

  const clearPendingMarkers = () => {
    for (const marker of pendingMarkers) {
      context.scene.value?.remove(marker);
      (marker.material as THREE.Material).dispose();
      // Don't dispose the shared sphere geometry
    }
    pendingMarkers = [];
  };

  const resetPending = () => {
    clearPendingMarkers();
  };

  // -----------------------------------------------------------------------
  // Measurement disposal
  // -----------------------------------------------------------------------

  const disposeMeasurement = (m: MeasurementVisual) => {
    // Remove LineMaterials from the resize-tracking set
    for (const mat of m.lineMaterials) allLineMaterials.delete(mat);

    // Dispose Three.js resources in the group (geometries + materials)
    m.group.traverse((child) => {
      const obj = child as THREE.Mesh;
      if (obj.geometry && obj.geometry !== getSphereGeo()) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else (mat as THREE.Material).dispose();
      }
    });

    // Remove the CSS2D label's DOM element
    if (m.label.element?.parentElement) {
      m.label.element.parentElement.removeChild(m.label.element);
    }

    context.scene.value?.remove(m.group);
  };

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Activate a measurement operator by name.
   * Returns `true` if the operator was activated, `false` if the viewer isn't
   * ready. Automatically deactivates any currently active operator first.
   */
  const activate = (operatorName: string): boolean => {
    if (!context.scene.value || !context.camera.value) return false;

    // Lazy-init the CSS2D overlay
    if (!css2dRenderer) initCSS2DRenderer();

    // Deactivate any current measurement mode first
    deactivate();

    activeMeasureType.value = operatorName;

    // Set crosshair cursor and attach pointer listeners (capture phase)
    const canvas = context.canvasEl.value;
    if (canvas) {
      previousCursor = canvas.style.cursor;
      canvas.style.cursor = "crosshair";
      canvas.addEventListener("pointerdown", onPointerDown, true);
      canvas.addEventListener("pointerup", onPointerUp, true);
      canvas.addEventListener("pointermove", onPointerMove, true);
    }

    if (operatorName === "SmartMeasure") {
      document.addEventListener("keydown", handleSmartKeyDown);
    }

    return true;
  };

  /** Deactivate the current measurement operator and clear pending state. */
  const deactivate = () => {
    if (!activeMeasureType.value && !pendingPlacement) return;

    // Cancel any in-flight label placement
    cancelPlacement();

    // Clean up SmartMeasure state
    resetSmartState();
    document.removeEventListener("keydown", handleSmartKeyDown);

    activeMeasureType.value = null;
    resetPending();

    const canvas = context.canvasEl.value;
    if (canvas) {
      canvas.style.cursor = previousCursor;
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointerup", onPointerUp, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
    }
  };

  /** Remove all measurements from the scene and deactivate. */
  const clearAll = () => {
    cancelPlacement();
    deactivate();
    for (const m of measurements) disposeMeasurement(m);
    measurements.length = 0;
  };

  /** Remove and dispose the most recently added measurement (for undo). */
  const removeLast = () => {
    if (measurements.length === 0) return;
    const m = measurements.pop()!;
    disposeMeasurement(m);
  };

  /** Export all measurements as serializable data. */
  const getAll = (): MeasurementData[] => {
    return measurements.map((m) => ({ ...m.data }));
  };

  /**
   * After creating a visual from loaded data, restore the custom label /
   * dimension-line position (if any).
   */
  const applyLabelPosition = (
    visual: MeasurementVisual,
    data: MeasurementData,
  ) => {
    if (!data.labelPosition) return;

    const lp = new THREE.Vector3(
      data.labelPosition.x,
      data.labelPosition.y,
      data.labelPosition.z,
    );
    visual.label.position.copy(lp);
    visual.data.labelPosition = { ...data.labelPosition };

    if (isRadiusType(visual)) {
      // For radius/diameter callouts the label position was determined by the
      // rotation angle chosen at placement time.  Nothing else to reconstruct.
      return;
    }

    if (isDimensionType(visual)) {
      // Reconstruct the perpendicular offset from the saved label position.
      const abDir = new THREE.Vector3().subVectors(
        visual.pointB,
        visual.pointA,
      );
      const abLen = abDir.length();
      if (abLen > 1e-10) {
        abDir.normalize();
        const mid = visual.pointA
          .clone()
          .add(visual.pointB)
          .multiplyScalar(0.5);
        const toLabel = lp.clone().sub(mid);
        const lateral = toLabel.dot(abDir);
        const perpOffset = toLabel.clone().addScaledVector(abDir, -lateral);

        const aPrime = visual.pointA.clone().add(perpOffset);
        const bPrime = visual.pointB.clone().add(perpOffset);

        if (visual.dimensionLine) {
          updateLinePositions(visual.dimensionLine, aPrime, bPrime);
        }

        const ext1 = createSolidLine(
          visual.pointA,
          aPrime,
          MEASURE_COLOR,
          0.45,
        );
        const ext2 = createSolidLine(
          visual.pointB,
          bPrime,
          MEASURE_COLOR,
          0.45,
        );
        visual.extensionLine1 = ext1;
        visual.extensionLine2 = ext2;
        visual.group.add(ext1, ext2);

        // Reconstruct leader if label is outside the A'-B' segment
        const projOnDim = lp.clone().sub(aPrime).dot(abDir);
        if (projOnDim < 0) {
          const leader = createSolidLine(aPrime, lp, MEASURE_COLOR, 0.9);
          visual.leaderLine = leader;
          visual.group.add(leader);
        } else if (projOnDim > abLen) {
          const leader = createSolidLine(bPrime, lp, MEASURE_COLOR, 0.9);
          visual.leaderLine = leader;
          visual.group.add(leader);
        }
      }
    } else {
      // Angle: simple leader line from midpoint
      const leader = createSolidLine(visual.midpoint, lp, MEASURE_COLOR, 0.45);
      visual.leaderLine = leader;
      visual.group.add(leader);
    }
  };

  /** Recreate measurements from previously exported data. */
  const loadAll = (dataArray: MeasurementData[]) => {
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0)
      return;

    // Lazy-init the CSS2D overlay
    if (!css2dRenderer) initCSS2DRenderer();

    for (const data of dataArray) {
      switch (data.type) {
        case "point-to-point": {
          if (data.points.length >= 2) {
            const p1 = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const p2 = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const visual = createPointToPointVisual(p1, p2);
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
        case "edge-length": {
          // We don't have the original mesh reference, so recreate as a
          // simple two-point visualisation with the stored edge endpoints.
          if (data.points.length >= 2) {
            const p1 = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const p2 = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const visual = createPointToPointVisual(p1, p2);
            visual.data = { ...data }; // preserve original type + value
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
        case "face-face-angle":
        case "smart-face-angle": {
          if (
            data.points.length >= 2 &&
            data.normals &&
            data.normals.length >= 2
          ) {
            const p1 = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const p2 = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const n1 = new THREE.Vector3(
              data.normals[0].x,
              data.normals[0].y,
              data.normals[0].z,
            );
            const n2 = new THREE.Vector3(
              data.normals[1].x,
              data.normals[1].y,
              data.normals[1].z,
            );
            const visual = createFaceAngleVisual(p1, n1, p2, n2);
            visual.data = { ...data };
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
        case "smart-edge-radius":
        case "smart-cylinder-radius": {
          if (data.points.length >= 2) {
            const center = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const edgePt = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const circleNormal =
              data.normals && data.normals.length > 0
                ? new THREE.Vector3(
                    data.normals[0].x,
                    data.normals[0].y,
                    data.normals[0].z,
                  )
                : new THREE.Vector3(0, 1, 0);

            const storedRadius =
              data.displayMode === "diameter" ? data.value / 2 : data.value;
            const radialDir = edgePt.clone().sub(center).normalize();
            const isDiam = data.displayMode === "diameter";

            const id = `measure-${++measureIdCounter}-${Date.now()}`;
            const group = new THREE.Group();
            group.userData.isMeasurement = true;

            let visual: MeasurementVisual;
            if (isDiam) {
              const callout = buildDiameterCallout(
                group,
                center,
                storedRadius,
                circleNormal,
                radialDir,
              );
              const label = createLabel(
                `\u2300 ${formatDistance(data.value)}`,
                callout.leaderTip,
              );
              group.add(label);
              context.scene.value!.add(group);
              visual = {
                id,
                data: { ...data },
                group,
                label,
                markers: callout.markers,
                lineMaterials: [],
                midpoint: callout.leaderTip.clone(),
                pointA: center.clone(),
                pointB: callout.arcPt1.clone(),
                dimensionLine: null,
                extensionLine1: null,
                extensionLine2: null,
                leaderLine: null,
                constraintPlane:
                  new THREE.Plane().setFromNormalAndCoplanarPoint(
                    circleNormal,
                    callout.leaderTip,
                  ),
                calloutGroup: callout.calloutGroup,
                arcCenter: center.clone(),
                arcRadius: storedRadius,
                circleNormal: circleNormal.clone(),
              };
            } else {
              const callout = buildRadiusCallout(
                group,
                center,
                storedRadius,
                circleNormal,
                radialDir,
              );
              const label = createLabel(
                `R ${formatDistance(data.value)}`,
                callout.midpoint,
              );
              group.add(label);
              context.scene.value!.add(group);
              visual = {
                id,
                data: { ...data },
                group,
                label,
                markers: callout.markers,
                lineMaterials: [],
                midpoint: callout.midpoint.clone(),
                pointA: center.clone(),
                pointB: callout.arcPt.clone(),
                dimensionLine: null,
                extensionLine1: null,
                extensionLine2: null,
                leaderLine: null,
                constraintPlane:
                  new THREE.Plane().setFromNormalAndCoplanarPoint(
                    circleNormal,
                    callout.midpoint,
                  ),
                calloutGroup: callout.calloutGroup,
                arcCenter: center.clone(),
                arcRadius: storedRadius,
                circleNormal: circleNormal.clone(),
              };
            }
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
        case "smart-face-distance": {
          if (
            data.points.length >= 2 &&
            data.normals &&
            data.normals.length >= 2
          ) {
            const p1 = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const p2 = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const n1 = new THREE.Vector3(
              data.normals[0].x,
              data.normals[0].y,
              data.normals[0].z,
            );
            const n2 = new THREE.Vector3(
              data.normals[1].x,
              data.normals[1].y,
              data.normals[1].z,
            );
            const visual = createSmartFaceDistanceVisual(p1, n1, p2, n2);
            visual.data = { ...data };
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
        case "smart-edge-length":
        case "smart-edge-distance":
        case "smart-face-edge-distance":
        case "smart-point-distance":
        case "smart-point-edge-distance":
        case "smart-point-face-distance": {
          if (data.points.length >= 2) {
            const p1 = new THREE.Vector3(
              data.points[0].x,
              data.points[0].y,
              data.points[0].z,
            );
            const p2 = new THREE.Vector3(
              data.points[1].x,
              data.points[1].y,
              data.points[1].z,
            );
            const visual = createPointToPointVisual(p1, p2);
            visual.data = { ...data };
            applyLabelPosition(visual, data);
            measurements.push(visual);
          }
          break;
        }
      }
    }
  };

  /** Register a callback fired whenever a measurement is completed. */
  const setOnMeasurementCreated = (cb: () => void) => {
    onCreatedCallback = cb;
  };

  /** Full cleanup (remove visuals, DOM overlay, event listeners). */
  const dispose = () => {
    clearAll();
    if (css2dRenderer) {
      css2dRenderer.domElement.remove();
      css2dRenderer = null;
    }
  };

  return {
    // Reactive state
    activeMeasureType,
    currentMeasureInfo,
    selectedMeasurementId,

    // Core API
    activate,
    deactivate,
    clearAll,
    removeLast,
    getAll,
    loadAll,
    selectMeasurement,

    // Toggle support
    togglePendingMode,
    toggleMeasurementMode,
    toggleCenterEdgePending,
    toggleCenterEdgeById,

    // Render-loop integration
    render,
    resize,

    // Lifecycle
    setOnMeasurementCreated,
    dispose,
  };
}
