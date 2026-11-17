/**
 * Web Worker for cap geometry computation.
 * Handles loop connection, classification, and triangulation off the main thread.
 *
 * Uses plain math (no THREE.js dependency) for lightweight worker bundle.
 */

import { Earcut } from "three/src/extras/Earcut.js";
import type {
  ToWorkerMessage,
  FromWorkerMessage,
  SerializedSegments,
  SerializedPlane,
  SerializedCapGeometry,
  GeometryGroup,
} from "./capWorker.types";

// Simple 3D vector type (no THREE.js)
type Vec3 = { x: number; y: number; z: number };

// Edge segment type with color tracking
type EdgeSegment = { start: Vec3; end: Vec3; colorIndex: number };

// Polygon loop with color tracking
type PolygonLoop = Vec3[];

// Loop with associated color (determined by majority of segments)
type ColoredLoop = {
  loop: PolygonLoop;
  colorIndex: number;
};

// Plane basis for 2D projection
type PlaneBasis = {
  u: Vec3;
  v: Vec3;
  origin: Vec3;
};

// ============================================================================
// Vector math utilities (no THREE.js)
// ============================================================================

const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const vec3Clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

const vec3Sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const vec3Dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const vec3Cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const vec3Length = (v: Vec3): number =>
  Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

const vec3Normalize = (v: Vec3): Vec3 => {
  const len = vec3Length(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};

const vec3DistanceSquared = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

// ============================================================================
// Deserialize segments from flat array
// ============================================================================

const deserializeSegments = (serialized: SerializedSegments): EdgeSegment[] => {
  const segments: EdgeSegment[] = [];
  const { data, colorIds, count } = serialized;

  for (let i = 0; i < count; i++) {
    const offset = i * 6;
    segments.push({
      start: vec3(data[offset], data[offset + 1], data[offset + 2]),
      end: vec3(data[offset + 3], data[offset + 4], data[offset + 5]),
      colorIndex: colorIds[i],
    });
  }

  return segments;
};

// ============================================================================
// Loop connection algorithm (spatial hashing)
// ============================================================================

/**
 * Connect segments into closed loops and track the color of each loop.
 * The loop's color is determined by the majority color of its segments.
 */
const connectSegmentsToLoops = (
  segments: EdgeSegment[],
  epsilon: number = 1e-4,
): ColoredLoop[] => {
  if (segments.length === 0) return [];

  // Quantize vertex position to a string key for spatial hashing
  const quantize = (v: Vec3): string => {
    const scale = 1 / epsilon;
    return `${Math.round(v.x * scale)},${Math.round(v.y * scale)},${Math.round(v.z * scale)}`;
  };

  // Build adjacency map
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

  // Track used segments
  const used = new Set<number>();
  const coloredLoops: ColoredLoop[] = [];

  // Process all segments
  for (let startSegIdx = 0; startSegIdx < segments.length; startSegIdx++) {
    if (used.has(startSegIdx)) continue;

    const loop: Vec3[] = [];
    const segmentIndices: number[] = []; // Track which segments form this loop
    let currentVertex = vec3Clone(segments[startSegIdx].start);
    const startVertex = vec3Clone(currentVertex);
    const startKey = quantize(startVertex);
    let naturallyClosed = false;

    loop.push(vec3Clone(currentVertex));
    used.add(startSegIdx);
    segmentIndices.push(startSegIdx);

    currentVertex = vec3Clone(segments[startSegIdx].end);
    loop.push(vec3Clone(currentVertex));

    let maxIterations = segments.length + 1;
    while (maxIterations-- > 0) {
      const currentKey = quantize(currentVertex);
      const distToStart = vec3DistanceSquared(currentVertex, startVertex);
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
        segmentIndices.push(ref.segmentIndex);
        const nextSeg = segments[ref.segmentIndex];

        if (ref.isStart) {
          currentVertex = vec3Clone(nextSeg.end);
        } else {
          currentVertex = vec3Clone(nextSeg.start);
        }

        loop.push(vec3Clone(currentVertex));
        foundNext = true;
        break;
      }

      if (!foundNext) break;
    }

    if (loop.length >= 3 && naturallyClosed) {
      // Determine majority color for this loop
      const colorCounts = new Map<number, number>();
      for (const segIdx of segmentIndices) {
        const colorIdx = segments[segIdx].colorIndex;
        colorCounts.set(colorIdx, (colorCounts.get(colorIdx) || 0) + 1);
      }

      let majorityColor = 0;
      let maxCount = 0;
      for (const [colorIdx, count] of colorCounts) {
        if (count > maxCount) {
          maxCount = count;
          majorityColor = colorIdx;
        }
      }

      coloredLoops.push({ loop, colorIndex: majorityColor });
    }
  }

  return coloredLoops;
};

// ============================================================================
// Plane basis and projection
// ============================================================================

const createPlaneBasis = (plane: SerializedPlane): PlaneBasis => {
  const normal = vec3Normalize(
    vec3(plane.normal[0], plane.normal[1], plane.normal[2]),
  );
  let u: Vec3;

  // Find a vector not parallel to the normal
  if (Math.abs(normal.x) < 0.9) {
    u = vec3Normalize(vec3Cross(normal, vec3(1, 0, 0)));
  } else {
    u = vec3Normalize(vec3Cross(normal, vec3(0, 1, 0)));
  }
  const v = vec3Normalize(vec3Cross(normal, u));

  // Get a point on the plane: origin = -constant * normal
  const origin = vec3(
    -plane.constant * normal.x,
    -plane.constant * normal.y,
    -plane.constant * normal.z,
  );

  return { u, v, origin };
};

const projectLoopTo2D = (loop: PolygonLoop, basis: PlaneBasis): number[] => {
  const points2D: number[] = [];

  for (const p of loop) {
    const rel = vec3Sub(p, basis.origin);
    points2D.push(vec3Dot(rel, basis.u), vec3Dot(rel, basis.v));
  }

  return points2D;
};

// ============================================================================
// 2D geometry helpers
// ============================================================================

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

    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
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

// ============================================================================
// Loop filtering and classification
// ============================================================================

const filterDegenerateLoops = (
  coloredLoops: ColoredLoop[],
  basis: PlaneBasis,
  minArea: number = 1e-8,
): ColoredLoop[] => {
  return coloredLoops.filter(({ loop }) => {
    const points2D = projectLoopTo2D(loop, basis);
    const area = Math.abs(signedArea2D(points2D));
    return area > minArea;
  });
};

const classifyLoops = (
  coloredLoops: ColoredLoop[],
  basis: PlaneBasis,
): { outerLoops: ColoredLoop[]; holesByOuter: Map<number, PolygonLoop[]> } => {
  if (coloredLoops.length === 0) {
    return { outerLoops: [], holesByOuter: new Map() };
  }

  const projected: {
    coloredLoop: ColoredLoop;
    points2D: number[];
    area: number;
    isOuter: boolean;
  }[] = [];

  for (const coloredLoop of coloredLoops) {
    const points2D = projectLoopTo2D(coloredLoop.loop, basis);
    const area = signedArea2D(points2D);
    projected.push({ coloredLoop, points2D, area, isOuter: true });
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
      holesByOuter.get(parentIndex)!.push(current.coloredLoop.loop);
    } else {
      outerIndices.push(i);
    }
  }

  const outerLoops: ColoredLoop[] = [];
  const outerIndexMap = new Map<number, number>();

  for (let i = 0; i < outerIndices.length; i++) {
    const projIdx = outerIndices[i];
    outerLoops.push(projected[projIdx].coloredLoop);
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

// ============================================================================
// Triangulation
// ============================================================================

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

// ============================================================================
// Build final geometry
// ============================================================================

/**
 * Build geometry grouped by color for multi-material rendering.
 * Returns positions, indices, and groups for each color.
 */
const buildCapGeometry = (
  coloredLoops: ColoredLoop[],
  holesByOuter: Map<number, PolygonLoop[]>,
  basis: PlaneBasis,
  planeNormal: [number, number, number],
  colors: number[],
): SerializedCapGeometry => {
  // Group loops by color index
  const loopsByColor = new Map<
    number,
    { outerIndex: number; coloredLoop: ColoredLoop }[]
  >();

  for (let i = 0; i < coloredLoops.length; i++) {
    const coloredLoop = coloredLoops[i];
    const colorIdx = coloredLoop.colorIndex;
    if (!loopsByColor.has(colorIdx)) {
      loopsByColor.set(colorIdx, []);
    }
    loopsByColor.get(colorIdx)!.push({ outerIndex: i, coloredLoop });
  }

  const allPositions: number[] = [];
  const allIndices: number[] = [];
  const groups: GeometryGroup[] = [];
  let vertexOffset = 0;

  // Process each color group separately
  // Sort by color index for consistent ordering
  const colorIndices = Array.from(loopsByColor.keys()).sort((a, b) => a - b);

  for (const colorIdx of colorIndices) {
    const loopsForColor = loopsByColor.get(colorIdx)!;
    const groupStartIndex = allIndices.length;

    for (const { outerIndex, coloredLoop } of loopsForColor) {
      const holes = holesByOuter.get(outerIndex) || [];

      const outer2D = projectLoopTo2D(coloredLoop.loop, basis);
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

    const groupIndexCount = allIndices.length - groupStartIndex;
    if (groupIndexCount > 0) {
      groups.push({
        start: groupStartIndex,
        count: groupIndexCount,
        colorIndex: colorIdx,
      });
    }
  }

  if (allPositions.length === 0) {
    return null;
  }

  return {
    positions: new Float32Array(allPositions),
    indices: new Uint32Array(allIndices),
    normal: planeNormal,
    groups,
    colors,
  };
};

// ============================================================================
// Main processing function
// ============================================================================

const processSegments = (
  segments: SerializedSegments,
  plane: SerializedPlane,
): SerializedCapGeometry => {
  // 1. Deserialize segments
  const edgeSegments = deserializeSegments(segments);

  if (edgeSegments.length === 0) {
    return null;
  }

  // 2. Connect segments into closed loops with color tracking
  const coloredLoops = connectSegmentsToLoops(edgeSegments);

  if (coloredLoops.length === 0) {
    return null;
  }

  // 3. Create plane basis for 2D projection
  const basis = createPlaneBasis(plane);

  // 4. Filter out degenerate tiny loops
  const validLoops = filterDegenerateLoops(coloredLoops, basis);

  if (validLoops.length === 0) {
    return null;
  }

  // 5. Classify loops (outer vs holes)
  const { outerLoops, holesByOuter } = classifyLoops(validLoops, basis);

  if (outerLoops.length === 0) {
    return null;
  }

  // 6. Build triangulated geometry grouped by color
  return buildCapGeometry(
    outerLoops,
    holesByOuter,
    basis,
    plane.normal,
    segments.colors,
  );
};

// ============================================================================
// Worker message handler
// ============================================================================

self.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const message = event.data;

  if (message.type === "processSegments") {
    try {
      const geometry = processSegments(message.segments, message.plane);

      const response: FromWorkerMessage = {
        type: "result",
        requestId: message.requestId,
        geometry,
      };

      // Transfer the ArrayBuffers for zero-copy
      const transferables: Transferable[] = [];
      if (geometry) {
        transferables.push(geometry.positions.buffer, geometry.indices.buffer);
      }

      self.postMessage(response, { transfer: transferables });
    } catch (error) {
      const response: FromWorkerMessage = {
        type: "error",
        requestId: message.requestId,
        message: error instanceof Error ? error.message : "Unknown error",
      };
      self.postMessage(response);
    }
  }
};

// Signal that worker is ready
console.log("[CapWorker] Worker initialized");
