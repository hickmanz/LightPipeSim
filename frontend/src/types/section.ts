import type { ShallowRef } from "vue";
import type * as THREE from "three";
import type { InteractionManager } from "../composables/viewer/useInteractionManager";

/** Minimal controls interface needed by section planes. */
interface SectionCompatibleControls {
  enabled: boolean;
}

/** Cartesian axis — safe to index THREE.Vector3 with. */
export type CartesianAxis = "x" | "y" | "z";

/**
 * Axis identifier for section planes.
 * Includes the three Cartesian axes plus "face" for face-normal planes.
 */
export type PlaneAxis = CartesianAxis | "face";

/**
 * State of a single section plane for snapshot/restore.
 */
export interface SectionPlaneState {
  /** Which axis this plane cuts along */
  axis: PlaneAxis;
  /** Position along the axis (plane constant) */
  position: number;
  /** Whether the plane normal is flipped */
  flipped: boolean;
}

/**
 * Complete snapshot of all section planes for save/restore.
 */
export interface SectionSnapshot {
  /** State of each active section plane */
  planes: SectionPlaneState[];
  /** Whether section edge lines are visible */
  showEdges: boolean;
}

/**
 * Context dependencies passed from useThreeViewer to useSectionPlanes.
 * This allows the section planes composable to access viewer resources
 * without tight coupling.
 */
export interface SectionPlanesContext {
  /** The Three.js scene */
  scene: ShallowRef<THREE.Scene | null>;
  /** The camera for raycasting during drag */
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  /** The renderer for canvas access */
  renderer: ShallowRef<THREE.WebGLRenderer | null>;
  /** Controls to disable during plane dragging */
  controls: ShallowRef<SectionCompatibleControls | null>;
  /** Interaction manager for suppressing orbit during drag */
  interaction: InteractionManager;
  /** Meshes with BVH for cap geometry computation */
  bvhMeshes: ShallowRef<THREE.Mesh[]>;
  /** Getter for model bounding box (may be null before model loads) */
  getModelBoundingBox: () => THREE.Box3 | null;
  /** Getter for cached materials to update clipping planes */
  getCachedMaterials: () => THREE.Material[];
  /** Canvas element for event listeners */
  getCanvas: () => HTMLCanvasElement | null;
}

/**
 * Resources created for each active section plane's cap and edges.
 */
export interface PlaneCapResources {
  /** The clipping plane */
  plane: THREE.Plane;
  /** Cap mesh that fills the cut surface */
  capMesh: THREE.Mesh;
  /** Fat line segments showing section edges */
  edgeLines: THREE.Object3D; // LineSegments2
  /** Pre-allocated buffer for edge positions */
  edgePositions: Float32Array;
}
