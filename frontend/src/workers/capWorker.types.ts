/**
 * Type definitions for cap geometry Web Worker communication.
 * Shared between main thread and worker.
 */

// Serialized edge segments as flat Float32Array for efficient transfer
export type SerializedSegments = {
  // Flat array: [x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, ...]
  // Each pair of 3D points (6 floats) is one segment
  data: Float32Array;
  // Color index for each segment (one per segment, indexes into colors array)
  colorIds: Uint16Array;
  count: number;
  // Color palette as hex values [0xRRGGBB, ...]
  colors: number[];
};

// Serialized plane definition
export type SerializedPlane = {
  normal: [number, number, number];
  constant: number;
};

// Geometry group for multi-material rendering
export type GeometryGroup = {
  start: number; // Start index in the indices array
  count: number; // Number of indices in this group
  colorIndex: number; // Index into the colors array
};

// Serialized cap geometry result
export type SerializedCapGeometry = {
  positions: Float32Array; // Vertex positions [x0,y0,z0, x1,y1,z1, ...]
  indices: Uint32Array; // Triangle indices
  normal: [number, number, number]; // Plane normal for all vertices
  groups: GeometryGroup[]; // Groups for multi-material rendering
  colors: number[]; // Color palette used (passed through from input)
} | null;

// Messages from main thread to worker
export type ToWorkerMessage = {
  type: "processSegments";
  requestId: number;
  segments: SerializedSegments;
  plane: SerializedPlane;
};

// Messages from worker to main thread
export type FromWorkerMessage =
  | { type: "result"; requestId: number; geometry: SerializedCapGeometry }
  | { type: "error"; requestId: number; message: string };
