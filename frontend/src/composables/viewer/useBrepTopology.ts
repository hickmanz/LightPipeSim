/**
 * useBrepTopology.ts
 *
 * Extracts and caches BREP topology data from GLB models produced by occt-converter.
 * The converter embeds per-vertex _FACE_ID and _EDGE_ID attributes that map tessellated
 * geometry back to original BREP faces and edges. This module provides lookup functions
 * used by the SmartMeasure tool for entity-level hover highlighting and measurement.
 */
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrepEdge {
  segments: [THREE.Vector3, THREE.Vector3][];
  totalLength: number;
  endpoints: [THREE.Vector3, THREE.Vector3];
}

export interface BrepFace {
  triangleIndices: number[];
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
}

export interface BrepEdgeHit {
  edgeId: number;
  edge: BrepEdge;
  closestPoint: THREE.Vector3;
  distance: number;
}

export interface MinDistanceResult {
  distance: number;
  pointOnA: THREE.Vector3;
  pointOnB: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Cache storage
// ---------------------------------------------------------------------------

// Per-instance edge topology: instanceNode -> Map<edgeId, BrepEdge>
const edgeCache = new WeakMap<THREE.Object3D, Map<number, BrepEdge>>();

// Per-mesh face topology: mesh -> Map<faceId, BrepFace>
const faceCache = new WeakMap<THREE.Mesh, Map<number, BrepFace>>();

// ---------------------------------------------------------------------------
// Edge topology extraction (called during model load, before fat line conversion)
// ---------------------------------------------------------------------------

/**
 * Extract _edge_id topology from a Line or LineSegments object and cache it
 * under the parent instance node. Must be called BEFORE convertToFatLine
 * disposes the original geometry.
 *
 * Handles both THREE.LineSegments (GL_LINES: independent pairs 0-1, 2-3, ...)
 * and THREE.Line (GL_LINE_STRIP: polyline 0-1, 1-2, 2-3, ...).
 */
export function extractEdgeTopology(
  lineObj: THREE.Line | THREE.LineSegments,
  instanceNode: THREE.Object3D,
): void {
  const geometry = lineObj.geometry as THREE.BufferGeometry;
  const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
  const edgeIdAttr = (geometry.getAttribute("_EDGE_ID") ??
    geometry.getAttribute("_edge_id")) as THREE.BufferAttribute;

  if (!posAttr) {
    console.warn(
      "[useBrepTopology] Line geometry has no position attribute, skipping edge extraction",
    );
    return;
  }
  if (!edgeIdAttr) {
    console.warn(
      "[useBrepTopology] Line geometry missing _EDGE_ID attribute (available:",
      Array.from(
        geometry.attributes ? Object.keys(geometry.attributes) : [],
      ).join(", "),
      "), skipping edge extraction",
    );
    return;
  }

  // Compute relative transform: lineObj-local -> instanceNode-local
  // This is needed because edge geometry positions are in the line object's
  // local space, but we store/query them in instance-node local space.
  lineObj.updateWorldMatrix(true, false);
  instanceNode.updateWorldMatrix(true, false);
  const relMatrix = new THREE.Matrix4()
    .copy(instanceNode.matrixWorld)
    .invert()
    .multiply(lineObj.matrixWorld);

  const isSegments = lineObj instanceof THREE.LineSegments;
  const edgeMap: Map<number, { positions: THREE.Vector3[] }> = new Map();

  const addSegment = (vi0: number, vi1: number) => {
    const edgeId = Math.round(edgeIdAttr.getX(vi0));
    const p0 = new THREE.Vector3()
      .fromBufferAttribute(posAttr, vi0)
      .applyMatrix4(relMatrix);
    const p1 = new THREE.Vector3()
      .fromBufferAttribute(posAttr, vi1)
      .applyMatrix4(relMatrix);
    let entry = edgeMap.get(edgeId);
    if (!entry) {
      entry = { positions: [] };
      edgeMap.set(edgeId, entry);
    }
    entry.positions.push(p0, p1);
  };

  if (geometry.index) {
    const index = geometry.index;
    if (isSegments) {
      // GL_LINES: pairs (0,1), (2,3), (4,5), ...
      for (let i = 0; i < index.count; i += 2) {
        addSegment(index.getX(i), index.getX(i + 1));
      }
    } else {
      // GL_LINE_STRIP: consecutive (0,1), (1,2), (2,3), ...
      for (let i = 0; i < index.count - 1; i++) {
        addSegment(index.getX(i), index.getX(i + 1));
      }
    }
  } else {
    if (isSegments) {
      for (let i = 0; i < posAttr.count; i += 2) {
        addSegment(i, i + 1);
      }
    } else {
      for (let i = 0; i < posAttr.count - 1; i++) {
        addSegment(i, i + 1);
      }
    }
  }

  const brepEdges = new Map<number, BrepEdge>();
  for (const [edgeId, entry] of edgeMap) {
    const segments: [THREE.Vector3, THREE.Vector3][] = [];
    let totalLength = 0;
    for (let i = 0; i < entry.positions.length; i += 2) {
      const a = entry.positions[i];
      const b = entry.positions[i + 1];
      segments.push([a, b]);
      totalLength += a.distanceTo(b);
    }
    if (segments.length === 0) continue;

    const first = segments[0][0];
    const last = segments[segments.length - 1][1];
    brepEdges.set(edgeId, {
      segments,
      totalLength,
      endpoints: [first.clone(), last.clone()],
    });
  }

  if (brepEdges.size > 0) {
    console.log(
      `[useBrepTopology] Extracted ${brepEdges.size} BREP edges from ${isSegments ? "LineSegments" : "Line"} for instance "${instanceNode.name || instanceNode.id}"`,
    );
  }

  // Merge with any existing data for this instance
  const existing = edgeCache.get(instanceNode);
  if (existing) {
    for (const [id, edge] of brepEdges) {
      existing.set(id, edge);
    }
  } else {
    edgeCache.set(instanceNode, brepEdges);
  }
}

// ---------------------------------------------------------------------------
// Face topology extraction (lazy, on demand)
// ---------------------------------------------------------------------------

function buildFaceCache(mesh: THREE.Mesh): Map<number, BrepFace> {
  const map = new Map<number, BrepFace>();
  const geometry = mesh.geometry;
  if (!geometry) return map;

  const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
  const faceIdAttr = (geometry.getAttribute("_FACE_ID") ??
    geometry.getAttribute("_face_id")) as THREE.BufferAttribute;
  const indexAttr = geometry.index;

  if (!posAttr || !faceIdAttr || !indexAttr) return map;

  const triCount = indexAttr.count / 3;
  const _v0 = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _ab = new THREE.Vector3();
  const _ac = new THREE.Vector3();
  const _cross = new THREE.Vector3();

  for (let tri = 0; tri < triCount; tri++) {
    const i0 = indexAttr.getX(tri * 3);
    const i1 = indexAttr.getX(tri * 3 + 1);
    const i2 = indexAttr.getX(tri * 3 + 2);

    const faceId = Math.round(faceIdAttr.getX(i0));

    _v0.fromBufferAttribute(posAttr, i0);
    _v1.fromBufferAttribute(posAttr, i1);
    _v2.fromBufferAttribute(posAttr, i2);

    _ab.subVectors(_v1, _v0);
    _ac.subVectors(_v2, _v0);
    _cross.crossVectors(_ab, _ac);
    const area = _cross.length() * 0.5;

    let entry = map.get(faceId);
    if (!entry) {
      entry = {
        triangleIndices: [],
        normal: new THREE.Vector3(),
        centroid: new THREE.Vector3(),
      };
      map.set(faceId, entry);
    }

    entry.triangleIndices.push(tri);

    // Accumulate area-weighted normal (not yet normalized)
    if (area > 1e-12) {
      entry.normal.addScaledVector(_cross.normalize(), area);
    }

    // Accumulate centroid
    const triCentroid = _v0.clone().add(_v1).add(_v2).divideScalar(3);
    entry.centroid.add(triCentroid);
  }

  // Finalize normals and centroids
  for (const face of map.values()) {
    face.normal.normalize();
    if (face.triangleIndices.length > 0) {
      face.centroid.divideScalar(face.triangleIndices.length);
    }
  }

  faceCache.set(mesh, map);
  return map;
}

// ---------------------------------------------------------------------------
// Public lookup API
// ---------------------------------------------------------------------------

/**
 * Get the BREP face ID for a given triangle (by faceIndex from raycast).
 */
export function getFaceIdAtTriangle(
  mesh: THREE.Mesh,
  faceIndex: number,
): number | null {
  const faceIdAttr = (mesh.geometry?.getAttribute("_FACE_ID") ??
    mesh.geometry?.getAttribute("_face_id")) as
    | THREE.BufferAttribute
    | undefined;
  const indexAttr = mesh.geometry?.index;
  if (!faceIdAttr || !indexAttr) return null;

  const i0 = indexAttr.getX(faceIndex * 3);
  return Math.round(faceIdAttr.getX(i0));
}

/**
 * Get cached BREP face data for a mesh + faceId. Builds cache on first call.
 */
export function getBrepFaceData(
  mesh: THREE.Mesh,
  faceId: number,
): BrepFace | null {
  let map = faceCache.get(mesh);
  if (!map) {
    map = buildFaceCache(mesh);
  }
  return map.get(faceId) ?? null;
}

/**
 * Build a Float32Array of triangle positions for a BREP face (for overlay geometry).
 * Positions are in local space (apply mesh.matrixWorld for world space).
 */
export function getBrepFaceTrianglePositions(
  mesh: THREE.Mesh,
  faceId: number,
): Float32Array | null {
  const face = getBrepFaceData(mesh, faceId);
  if (!face) return null;

  const posAttr = mesh.geometry.getAttribute(
    "position",
  ) as THREE.BufferAttribute;
  const indexAttr = mesh.geometry.index;
  if (!posAttr || !indexAttr) return null;

  const positions = new Float32Array(face.triangleIndices.length * 9);
  let offset = 0;

  for (const tri of face.triangleIndices) {
    const i0 = indexAttr.getX(tri * 3);
    const i1 = indexAttr.getX(tri * 3 + 1);
    const i2 = indexAttr.getX(tri * 3 + 2);

    positions[offset++] = posAttr.getX(i0);
    positions[offset++] = posAttr.getY(i0);
    positions[offset++] = posAttr.getZ(i0);
    positions[offset++] = posAttr.getX(i1);
    positions[offset++] = posAttr.getY(i1);
    positions[offset++] = posAttr.getZ(i1);
    positions[offset++] = posAttr.getX(i2);
    positions[offset++] = posAttr.getY(i2);
    positions[offset++] = posAttr.getZ(i2);
  }

  return positions;
}

/**
 * Return per-vertex normals for every triangle belonging to a BREP face.
 * Layout: Float32Array [nx0,ny0,nz0, nx1,ny1,nz1, nx2,ny2,nz2, ...] (9 per tri).
 */
export function getBrepFaceTriangleNormals(
  mesh: THREE.Mesh,
  faceId: number,
): Float32Array | null {
  const face = getBrepFaceData(mesh, faceId);
  if (!face) return null;

  const normalAttr = mesh.geometry.getAttribute(
    "normal",
  ) as THREE.BufferAttribute;
  const indexAttr = mesh.geometry.index;
  if (!normalAttr || !indexAttr) return null;

  const normals = new Float32Array(face.triangleIndices.length * 9);
  let offset = 0;

  for (const tri of face.triangleIndices) {
    const i0 = indexAttr.getX(tri * 3);
    const i1 = indexAttr.getX(tri * 3 + 1);
    const i2 = indexAttr.getX(tri * 3 + 2);

    normals[offset++] = normalAttr.getX(i0);
    normals[offset++] = normalAttr.getY(i0);
    normals[offset++] = normalAttr.getZ(i0);
    normals[offset++] = normalAttr.getX(i1);
    normals[offset++] = normalAttr.getY(i1);
    normals[offset++] = normalAttr.getZ(i1);
    normals[offset++] = normalAttr.getX(i2);
    normals[offset++] = normalAttr.getY(i2);
    normals[offset++] = normalAttr.getZ(i2);
  }

  return normals;
}

/**
 * Find the nearest BREP edge to a world-space point for a given instance node.
 */
export function findNearestBrepEdge(
  instanceNode: THREE.Object3D,
  worldPoint: THREE.Vector3,
): BrepEdgeHit | null {
  const edges = edgeCache.get(instanceNode);
  if (!edges) return null;

  // Transform world point into instance local space
  const invMatrix = new THREE.Matrix4().copy(instanceNode.matrixWorld).invert();
  const localPoint = worldPoint.clone().applyMatrix4(invMatrix);

  let bestEdgeId = -1;
  let bestDist = Infinity;
  let bestClosest = new THREE.Vector3();

  const _seg = new THREE.Vector3();
  const _toPoint = new THREE.Vector3();

  for (const [edgeId, edge] of edges) {
    for (const [a, b] of edge.segments) {
      _seg.subVectors(b, a);
      const segLen = _seg.length();
      if (segLen < 1e-10) continue;
      _seg.normalize();

      _toPoint.subVectors(localPoint, a);
      const t = Math.max(0, Math.min(segLen, _toPoint.dot(_seg)));
      const proj = a.clone().addScaledVector(_seg, t);
      const d = localPoint.distanceTo(proj);

      if (d < bestDist) {
        bestDist = d;
        bestEdgeId = edgeId;
        bestClosest = proj;
      }
    }
  }

  if (bestEdgeId < 0) return null;

  // Transform closest point back to world space
  bestClosest.applyMatrix4(instanceNode.matrixWorld);
  const worldDist = worldPoint.distanceTo(bestClosest);

  return {
    edgeId: bestEdgeId,
    edge: edges.get(bestEdgeId)!,
    closestPoint: bestClosest,
    distance: worldDist,
  };
}

/**
 * Get world-space segment positions for a BREP edge.
 */
export function getBrepEdgeWorldPositions(
  instanceNode: THREE.Object3D,
  edgeId: number,
): [THREE.Vector3, THREE.Vector3][] | null {
  const edges = edgeCache.get(instanceNode);
  if (!edges) return null;

  const edge = edges.get(edgeId);
  if (!edge) return null;

  return edge.segments.map(([a, b]) => [
    a.clone().applyMatrix4(instanceNode.matrixWorld),
    b.clone().applyMatrix4(instanceNode.matrixWorld),
  ]);
}

/**
 * Get BREP edge data (local space) for a given instance + edgeId.
 */
export function getBrepEdgeData(
  instanceNode: THREE.Object3D,
  edgeId: number,
): BrepEdge | null {
  const edges = edgeCache.get(instanceNode);
  return edges?.get(edgeId) ?? null;
}

// ---------------------------------------------------------------------------
// Distance computations
// ---------------------------------------------------------------------------

/**
 * Closest distance between two line segments (a0-a1) and (b0-b1).
 */
function closestDistSegSeg(
  a0: THREE.Vector3,
  a1: THREE.Vector3,
  b0: THREE.Vector3,
  b1: THREE.Vector3,
): { dist: number; ptA: THREE.Vector3; ptB: THREE.Vector3 } {
  const d1 = new THREE.Vector3().subVectors(a1, a0);
  const d2 = new THREE.Vector3().subVectors(b1, b0);
  const r = new THREE.Vector3().subVectors(a0, b0);

  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);

  let s: number, t: number;

  if (a <= 1e-10 && e <= 1e-10) {
    s = t = 0;
  } else if (a <= 1e-10) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= 1e-10) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;

      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
      } else {
        s = 0;
      }

      t = (b * s + f) / e;

      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const ptA = a0.clone().addScaledVector(d1, s);
  const ptB = b0.clone().addScaledVector(d2, t);

  return { dist: ptA.distanceTo(ptB), ptA, ptB };
}

/**
 * Compute minimum distance between two BREP edges (in world space).
 */
export function computeMinEdgeToEdgeDistance(
  edgeA: BrepEdge,
  edgeB: BrepEdge,
  matA: THREE.Matrix4,
  matB: THREE.Matrix4,
): MinDistanceResult {
  let bestDist = Infinity;
  let bestPtA = new THREE.Vector3();
  let bestPtB = new THREE.Vector3();

  for (const [a0, a1] of edgeA.segments) {
    const wa0 = a0.clone().applyMatrix4(matA);
    const wa1 = a1.clone().applyMatrix4(matA);

    for (const [b0, b1] of edgeB.segments) {
      const wb0 = b0.clone().applyMatrix4(matB);
      const wb1 = b1.clone().applyMatrix4(matB);

      const { dist, ptA, ptB } = closestDistSegSeg(wa0, wa1, wb0, wb1);
      if (dist < bestDist) {
        bestDist = dist;
        bestPtA = ptA;
        bestPtB = ptB;
      }
    }
  }

  return { distance: bestDist, pointOnA: bestPtA, pointOnB: bestPtB };
}

/**
 * Compute minimum distance from a BREP edge to a BREP face plane (in world space).
 * Uses the face's average normal and centroid to define an infinite plane,
 * then finds the closest point on the edge polyline to that plane.
 */
export function computeMinEdgeToFaceDistance(
  edge: BrepEdge,
  face: BrepFace,
  edgeMat: THREE.Matrix4,
  faceMesh: THREE.Mesh,
): MinDistanceResult {
  // Build face plane in world space
  const worldNormal = face.normal
    .clone()
    .transformDirection(faceMesh.matrixWorld)
    .normalize();
  const worldCentroid = face.centroid
    .clone()
    .applyMatrix4(faceMesh.matrixWorld);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    worldNormal,
    worldCentroid,
  );

  let bestDist = Infinity;
  let bestPtEdge = new THREE.Vector3();
  let bestPtFace = new THREE.Vector3();

  for (const [a, b] of edge.segments) {
    const wa = a.clone().applyMatrix4(edgeMat);
    const wb = b.clone().applyMatrix4(edgeMat);

    // Distance to plane is linear along a segment, so min is at an endpoint
    // (or 0 if segment crosses the plane)
    const dA = plane.distanceToPoint(wa);
    const dB = plane.distanceToPoint(wb);

    if (dA * dB < 0) {
      // Segment crosses the plane -- distance is 0
      const t = dA / (dA - dB);
      const crossing = wa.clone().lerp(wb, t);
      if (0 < bestDist) {
        bestDist = 0;
        bestPtEdge = crossing;
        bestPtFace = crossing.clone();
      }
    } else {
      for (const pt of [wa, wb]) {
        const d = Math.abs(plane.distanceToPoint(pt));
        if (d < bestDist) {
          bestDist = d;
          bestPtEdge = pt;
          bestPtFace = plane.projectPoint(pt, new THREE.Vector3());
        }
      }
    }
  }

  return { distance: bestDist, pointOnA: bestPtEdge, pointOnB: bestPtFace };
}

// ---------------------------------------------------------------------------
// Circle fitting (frontend-only, from tessellated polyline points)
// ---------------------------------------------------------------------------

export interface CircleFitResult {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
}

/**
 * Attempt to fit a circle to an ordered set of 3D points.
 * Returns null if the points don't lie on a circle within tolerance.
 *
 * Algorithm:
 *   1. Compute best-fit plane normal from cross products of consecutive edges
 *   2. Build a local 2D coordinate frame on that plane
 *   3. Fit a 2D circle using Kasa's algebraic method (linear least squares)
 *   4. Reject if max point deviation from the fitted circle > 1% of radius
 */
export function fitCircle3D(points: THREE.Vector3[]): CircleFitResult | null {
  if (points.length < 3) return null;

  // 1. Best-fit plane normal: average of cross products of consecutive edge vectors
  const normal = new THREE.Vector3();
  for (let i = 1; i < points.length - 1; i++) {
    const v0 = new THREE.Vector3().subVectors(points[i], points[i - 1]);
    const v1 = new THREE.Vector3().subVectors(points[i + 1], points[i]);
    const cross = new THREE.Vector3().crossVectors(v0, v1);
    normal.add(cross);
  }
  if (normal.lengthSq() < 1e-20) return null;
  normal.normalize();

  // 2. Build local 2D frame on the plane
  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(p);
  centroid.divideScalar(points.length);

  // Choose a tangent vector not parallel to the normal
  const seed =
    Math.abs(normal.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const uAxis = new THREE.Vector3().crossVectors(normal, seed).normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

  // Project points to 2D (u, v)
  const pts2d: { u: number; v: number }[] = [];
  for (const p of points) {
    const d = new THREE.Vector3().subVectors(p, centroid);
    pts2d.push({ u: d.dot(uAxis), v: d.dot(vAxis) });
  }

  // 3. Kasa's algebraic circle fit
  //    Minimize sum( (xi - xc)^2 + (yi - yc)^2 - R^2 )^2
  //    Linear form: solve for A, B, C in  xi*A + yi*B + C = xi^2 + yi^2
  const n = pts2d.length;
  let sUU = 0,
    sVV = 0,
    sUV = 0;
  let sUUU = 0,
    sVVV = 0,
    sUUV = 0,
    sUVV = 0;

  for (const { u, v } of pts2d) {
    sUU += u * u;
    sVV += v * v;
    sUV += u * v;
    sUUU += u * u * u;
    sVVV += v * v * v;
    sUUV += u * u * v;
    sUVV += u * v * v;
  }

  // Solve 2x2 system for uc, vc:
  //   sUU * uc + sUV * vc = 0.5 * (sUUU + sUVV)
  //   sUV * uc + sVV * vc = 0.5 * (sUUV + sVVV)
  // (Shifted coordinates make the constant term simpler)
  const rhs1 = 0.5 * (sUUU + sUVV);
  const rhs2 = 0.5 * (sUUV + sVVV);
  const det = sUU * sVV - sUV * sUV;
  if (Math.abs(det) < 1e-20) return null;

  const uc = (sVV * rhs1 - sUV * rhs2) / det;
  const vc = (sUU * rhs2 - sUV * rhs1) / det;
  const rSq = uc * uc + vc * vc + (sUU + sVV) / n;
  if (rSq <= 0) return null;
  const radius = Math.sqrt(rSq);

  // 4. Check fit quality: max deviation from fitted circle
  let maxDeviation = 0;
  for (const { u, v } of pts2d) {
    const d = Math.abs(Math.sqrt((u - uc) ** 2 + (v - vc) ** 2) - radius);
    if (d > maxDeviation) maxDeviation = d;
  }

  const tolerance = 0.01 * radius;
  if (maxDeviation > tolerance) return null;

  // 5. Transform 2D center back to 3D
  const center = centroid
    .clone()
    .addScaledVector(uAxis, uc)
    .addScaledVector(vAxis, vc);

  return { center, radius, normal: normal.clone() };
}

// ---------------------------------------------------------------------------
// Cylinder fitting (frontend-only, from tessellated face geometry)
// ---------------------------------------------------------------------------

export interface CylinderFitResult {
  center: THREE.Vector3;
  axis: THREE.Vector3;
  radius: number;
}

/**
 * Detect whether a tessellated BREP face is cylindrical by analysing
 * per-vertex normals and positions.
 *
 * Algorithm:
 *   1. De-duplicate vertices; reject if too few unique samples
 *   2. Find the best-fit plane of the normal vectors -- its normal IS
 *      the cylinder axis (all surface normals are perpendicular to the axis)
 *   3. Verify normals are indeed perpendicular to the axis candidate
 *   4. Project vertex positions onto a plane perpendicular to the axis
 *   5. Kasa circle fit on the 2D projected points
 *   6. Reject if max deviation > 1% of radius
 */
export function fitCylinder3D(
  positions: Float32Array,
  normals: Float32Array,
): CylinderFitResult | null {
  const vertCount = positions.length / 3;
  if (vertCount < 6) return null;

  // 1. De-duplicate vertices (using a spatial hash with a small epsilon)
  const eps = 1e-6;
  const uniquePos: THREE.Vector3[] = [];
  const uniqueNrm: THREE.Vector3[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < vertCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const key = `${Math.round(px / eps)}_${Math.round(py / eps)}_${Math.round(pz / eps)}`;
    if (!seen.has(key)) {
      seen.set(key, uniquePos.length);
      uniquePos.push(new THREE.Vector3(px, py, pz));
      uniqueNrm.push(
        new THREE.Vector3(
          normals[i * 3],
          normals[i * 3 + 1],
          normals[i * 3 + 2],
        ).normalize(),
      );
    }
  }

  if (uniquePos.length < 6) return null;

  // 2. Find the best-fit plane of the normal vectors.
  //    For a cylinder, all normals lie in a plane perpendicular to the axis.
  //    The axis is the eigenvector of the normal covariance matrix with the
  //    smallest eigenvalue.  We compute N^T N (3x3) and use the smallest
  //    eigenvector via the power-iteration/deflation approach.
  const meanN = new THREE.Vector3();
  for (const n of uniqueNrm) meanN.add(n);
  meanN.divideScalar(uniqueNrm.length);

  // Covariance matrix of normals (symmetric 3x3)
  let c00 = 0,
    c01 = 0,
    c02 = 0,
    c11 = 0,
    c12 = 0,
    c22 = 0;
  for (const n of uniqueNrm) {
    const dx = n.x - meanN.x,
      dy = n.y - meanN.y,
      dz = n.z - meanN.z;
    c00 += dx * dx;
    c01 += dx * dy;
    c02 += dx * dz;
    c11 += dy * dy;
    c12 += dy * dz;
    c22 += dz * dz;
  }

  // Find the eigenvector with the SMALLEST eigenvalue via inverse power iteration
  // on (C - λ_max * I).  Simpler: find the two largest eigenvectors first, then
  // cross-product gives the smallest.  Here we just do power iteration on C to find
  // the dominant, then deflate and repeat for the second, then cross.
  const mulCov = (v: THREE.Vector3): THREE.Vector3 =>
    new THREE.Vector3(
      c00 * v.x + c01 * v.y + c02 * v.z,
      c01 * v.x + c11 * v.y + c12 * v.z,
      c02 * v.x + c12 * v.y + c22 * v.z,
    );

  const powerIter = (
    mul: (v: THREE.Vector3) => THREE.Vector3,
    iters = 40,
  ): THREE.Vector3 => {
    let v = new THREE.Vector3(1, 1, 1).normalize();
    for (let i = 0; i < iters; i++) {
      v = mul(v);
      const len = v.length();
      if (len < 1e-30) return new THREE.Vector3(1, 0, 0);
      v.divideScalar(len);
    }
    return v;
  };

  const ev1 = powerIter(mulCov);
  const lambda1 = mulCov(ev1).dot(ev1);

  // Deflate: C' = C - lambda1 * ev1 ev1^T
  const mulDeflated = (v: THREE.Vector3): THREE.Vector3 => {
    const cv = mulCov(v);
    const proj = ev1.clone().multiplyScalar(lambda1 * v.dot(ev1));
    return cv.sub(proj);
  };

  const ev2 = powerIter(mulDeflated);

  // Smallest eigenvector = cross(ev1, ev2)
  const axis = new THREE.Vector3().crossVectors(ev1, ev2).normalize();
  if (axis.lengthSq() < 1e-10) return null;

  // 3. Verify all normals are roughly perpendicular to the axis
  //    (for a plane, normals all point the same direction -> axis would be arbitrary)
  let maxDot = 0;
  let minDot = Infinity;
  for (const n of uniqueNrm) {
    const d = Math.abs(n.dot(axis));
    if (d > maxDot) maxDot = d;
    if (d < minDot) minDot = d;
  }
  // Reject if normals aren't perpendicular to axis (cylinder normals should have dot ≈ 0)
  if (maxDot > 0.15) return null;

  // Also reject flat faces: if all normals are nearly identical, it's a plane not a cylinder.
  // Check spread: the largest eigenvalue of the normal covariance should be substantial.
  if (lambda1 < 0.01) return null;

  // 4. Project vertex positions onto a plane perpendicular to axis
  const centroid = new THREE.Vector3();
  for (const p of uniquePos) centroid.add(p);
  centroid.divideScalar(uniquePos.length);

  const seed =
    Math.abs(axis.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const uAxis = new THREE.Vector3().crossVectors(axis, seed).normalize();
  const vAxis = new THREE.Vector3().crossVectors(axis, uAxis).normalize();

  const pts2d: { u: number; v: number }[] = [];
  for (const p of uniquePos) {
    const d = new THREE.Vector3().subVectors(p, centroid);
    pts2d.push({ u: d.dot(uAxis), v: d.dot(vAxis) });
  }

  // 5. Kasa circle fit (same as fitCircle3D)
  const nn = pts2d.length;
  let sUU = 0,
    sVV = 0,
    sUV = 0;
  let sUUU = 0,
    sVVV = 0,
    sUUV = 0,
    sUVV = 0;

  for (const { u, v } of pts2d) {
    sUU += u * u;
    sVV += v * v;
    sUV += u * v;
    sUUU += u * u * u;
    sVVV += v * v * v;
    sUUV += u * u * v;
    sUVV += u * v * v;
  }

  const rhs1 = 0.5 * (sUUU + sUVV);
  const rhs2 = 0.5 * (sUUV + sVVV);
  const det = sUU * sVV - sUV * sUV;
  if (Math.abs(det) < 1e-20) return null;

  const uc = (sVV * rhs1 - sUV * rhs2) / det;
  const vc = (sUU * rhs2 - sUV * rhs1) / det;
  const rSq = uc * uc + vc * vc + (sUU + sVV) / nn;
  if (rSq <= 0) return null;
  const radius = Math.sqrt(rSq);

  // 6. Validate fit quality
  let maxDeviation = 0;
  for (const { u, v } of pts2d) {
    const d = Math.abs(Math.sqrt((u - uc) ** 2 + (v - vc) ** 2) - radius);
    if (d > maxDeviation) maxDeviation = d;
  }

  if (maxDeviation > 0.01 * radius) return null;

  // Transform 2D center back to 3D (this is the axis point nearest to the centroid)
  const center3d = centroid
    .clone()
    .addScaledVector(uAxis, uc)
    .addScaledVector(vAxis, vc);

  return { center: center3d, axis: axis.clone(), radius };
}

/**
 * Extract ordered unique points from a BrepEdge's segments.
 * Segments are consecutive: [0][0]-[0][1], [1][0]-[1][1], ...
 * where [i][1] ≈ [i+1][0]. We take segments[0][0] then each segments[i][1].
 */
export function edgeToOrderedPoints(edge: BrepEdge): THREE.Vector3[] {
  if (edge.segments.length === 0) return [];
  const pts: THREE.Vector3[] = [edge.segments[0][0].clone()];
  for (const [, b] of edge.segments) {
    pts.push(b.clone());
  }
  return pts;
}

/**
 * Clear all cached topology data. Call when the model is unloaded.
 */
export function clearTopologyCache(): void {
  // WeakMaps self-clean when references are GC'd, but we expose
  // this for explicit cleanup if needed.
}
