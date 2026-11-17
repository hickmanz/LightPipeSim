import * as THREE from "three";

export interface DebugRaycastContext {
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  scene: THREE.Scene;
  loadedModel: THREE.Group;
  raycaster: THREE.Raycaster;
  bvhMeshes: THREE.Mesh[];
  modelBoundingBox: THREE.Box3 | null;
  getNormalizedCoords: (event: MouseEvent | PointerEvent) => THREE.Vector2;
  raycastFromCursor: (event: MouseEvent | PointerEvent) => THREE.Intersection[];
  isPointVisible: (point: THREE.Vector3) => boolean;
  getCapResources: () => Map<string, { capMesh: THREE.Mesh }>;
  addDebugLine: (from: THREE.Vector3, to: THREE.Vector3, color: number) => void;
  addDebugSphere: (point: THREE.Vector3, color: number, size: number) => void;
  clearDebugMarkers: () => void;
  debugObjects: THREE.Object3D[];
}

/**
 * Comprehensive raycast diagnostic. Fires a ray at the cursor position,
 * logs gate-by-gate pipeline analysis, and places visual debug markers.
 * Only runs when the viewer's `raycastDebugEnabled` flag is true.
 */
export function performDebugRaycast(
  event: MouseEvent,
  ctx: DebugRaycastContext,
) {
  ctx.clearDebugMarkers();

  ctx.scene.updateMatrixWorld(true);
  ctx.camera.updateMatrixWorld(true);
  ctx.camera.updateProjectionMatrix();
  const coords = ctx.getNormalizedCoords(event);
  ctx.raycaster.setFromCamera(coords, ctx.camera);
  ctx.raycaster.firstHitOnly = false;

  // 1. Visualise the ray
  const visOrigin = ctx.raycaster.ray.origin.clone();
  const visLength = ctx.camera.far;
  const visEnd = visOrigin
    .clone()
    .addScaledVector(ctx.raycaster.ray.direction, visLength);
  ctx.addDebugLine(visOrigin, visEnd, 0x00ffff);

  const camType =
    ctx.camera instanceof THREE.OrthographicCamera ? "Ortho" : "Perspective";
  console.log(`  Camera type: ${camType}`);

  // 2. Collect ALL raw hits
  const debugTargets: THREE.Object3D[] = [ctx.loadedModel];
  const capResources = ctx.getCapResources();
  for (const resources of capResources.values())
    debugTargets.push(resources.capMesh);
  const rawHits = ctx.raycaster.intersectObjects(debugTargets, true);

  // 3. Collect filtered hits
  const filtered = ctx.raycastFromCursor(event);

  // 4. Log comprehensive summary
  const camPos = ctx.camera.position;
  console.log(
    "%c[Raycast Debug] ════════════════════════════════════════",
    "color:#0af",
  );
  console.log(
    `  NDC coords : (${coords.x.toFixed(4)}, ${coords.y.toFixed(4)})`,
  );
  console.log(
    `  Camera pos : (${camPos.x.toFixed(2)}, ${camPos.y.toFixed(2)}, ${camPos.z.toFixed(2)})`,
  );
  console.log(
    `  Ray dir    : (${ctx.raycaster.ray.direction.x.toFixed(4)}, ${ctx.raycaster.ray.direction.y.toFixed(4)}, ${ctx.raycaster.ray.direction.z.toFixed(4)})`,
  );
  console.log(
    `  Raw hits   : ${rawHits.length}   Filtered hits: ${filtered.length}`,
  );

  const instanceName = (obj: THREE.Object3D): string => {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData?.cadreview_instanceId)
        return cur.name || cur.userData.cadreview_instanceId;
      cur = cur.parent;
    }
    return obj.name || "(no instance)";
  };

  // First 10 raw hits with filter reasons
  const MAX_SHOW = 10;
  console.log("  ── Raw hits (sorted by distance) ──");
  rawHits.slice(0, MAX_SHOW).forEach((h, i) => {
    const isMesh = h.object instanceof THREE.Mesh;
    const hasFace = !!h.face;
    const vis = h.object.visible;
    const ptVis = ctx.isPointVisible(h.point);
    const finite = Number.isFinite(h.distance);
    const kept = filtered.includes(h);
    const tag = kept ? "✓" : "✗";
    const reason = !finite
      ? "NaN/Inf dist"
      : !isMesh
        ? "not Mesh"
        : !hasFace
          ? "no face"
          : !vis
            ? "hidden"
            : !ptVis
              ? "clipped"
              : "";
    console.log(
      `  ${tag} [${i}] d=${h.distance.toFixed(4)}  instance="${instanceName(h.object)}"  obj="${h.object.name || "?"}"  ${reason}`,
    );
  });
  if (rawHits.length > MAX_SHOW)
    console.log(`  ... and ${rawHits.length - MAX_SHOW} more`);

  // 5. Orbit-stability snapshot
  {
    const cp = ctx.camera.position;
    const cq = ctx.camera.quaternion;
    const mw = ctx.camera.matrixWorld.elements;
    console.log("  ── Orbit-stability snapshot ──");
    console.log(
      `  cam.pos    : (${cp.x.toFixed(4)}, ${cp.y.toFixed(4)}, ${cp.z.toFixed(4)})`,
    );
    console.log(
      `  cam.quat   : (${cq.x.toFixed(6)}, ${cq.y.toFixed(6)}, ${cq.z.toFixed(6)}, ${cq.w.toFixed(6)})`,
    );
    console.log(
      `  cam.mW col3: (${mw[12].toFixed(4)}, ${mw[13].toFixed(4)}, ${mw[14].toFixed(4)})`,
    );
    const orthoShift =
      ctx.camera instanceof THREE.OrthographicCamera && ctx.camera.near < 0
        ? Math.abs(ctx.camera.near)
        : 0;
    console.log(
      `  raycaster  : near=${ctx.raycaster.near.toFixed(4)} far=${ctx.raycaster.far.toFixed(4)} orthoShift=${orthoShift.toFixed(2)}`,
    );
    const meshSnap = ctx.bvhMeshes.slice(0, 3);
    meshSnap.forEach((m) => {
      const e = m.matrixWorld.elements;
      console.log(
        `  mesh[${m.name}].mW col3: (${e[12].toFixed(4)}, ${e[13].toFixed(4)}, ${e[14].toFixed(4)})  autoUpdate=${m.matrixAutoUpdate}  stale=${m.matrixWorldNeedsUpdate}`,
      );
    });
  }

  // 6. Gate-by-gate pipeline analysis
  let viewScale: number;
  if (ctx.camera instanceof THREE.OrthographicCamera) {
    viewScale = (ctx.camera.top - ctx.camera.bottom) / ctx.camera.zoom;
  } else {
    viewScale = ctx.modelBoundingBox
      ? ctx.camera.position.distanceTo(
          ctx.modelBoundingBox.getCenter(new THREE.Vector3()),
        )
      : 10;
  }
  const sphereSize = viewScale * 0.003;
  const _diagSphere = new THREE.Sphere();
  let sphereHitCount = 0;
  let missCount = 0;
  const missedMeshBoxes: { mesh: THREE.Mesh; worldBox: THREE.Box3 }[] = [];
  console.log("  ── Pipeline gate analysis ──");
  for (const mesh of ctx.bvhMeshes) {
    if (!mesh.visible) continue;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    _diagSphere.copy(geo.boundingSphere!).applyMatrix4(mesh.matrixWorld);
    if (!ctx.raycaster.ray.intersectsSphere(_diagSphere)) continue;
    sphereHitCount++;

    const bvhHitCount = rawHits.filter((h) => h.object === mesh).length;
    const inst = instanceName(mesh);

    if (bvhHitCount > 0) {
      console.log(`    ${mesh.name} (${inst}): ${bvhHitCount} hits (OK)`);
      continue;
    }

    missCount++;

    // Gate A: layers
    const layersOK = mesh.layers.test(ctx.raycaster.layers);

    // Gate B: sphere_gate
    const recastRay = ctx.raycaster.ray.clone();
    recastRay.origin.addScaledVector(recastRay.direction, ctx.raycaster.near);
    const worldSphere = geo.boundingSphere!.clone();
    worldSphere.applyMatrix4(mesh.matrixWorld);
    let spherePass = worldSphere.containsPoint(recastRay.origin);
    if (!spherePass) {
      const hitAt = recastRay.intersectSphere(worldSphere, new THREE.Vector3());
      if (hitAt) {
        const d2 = recastRay.origin.distanceToSquared(hitAt);
        const maxD2 = (ctx.raycaster.far - ctx.raycaster.near) ** 2;
        spherePass = d2 <= maxD2;
      }
    }

    // Gate C: bbox_gate
    const invMat = mesh.matrixWorld.clone().invert();
    const localRay = ctx.raycaster.ray.clone().applyMatrix4(invMat);
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bboxPass =
      !geo.boundingBox || localRay.intersectsBox(geo.boundingBox);

    // Gate D: bvh_root_gate
    let bvhRootPass = false;
    const bvh = (geo as any).boundsTree;
    if (bvh && (bvh as any)._roots && (bvh as any)._roots.length > 0) {
      const rootBuf = new Float32Array((bvh as any)._roots[0]);
      const rootBox = new THREE.Box3(
        new THREE.Vector3(rootBuf[0], rootBuf[1], rootBuf[2]),
        new THREE.Vector3(rootBuf[3], rootBuf[4], rootBuf[5]),
      );
      bvhRootPass = localRay.intersectsBox(rootBox);
    }

    // Gate E: tri_sample (brute-force on up to 200 triangles)
    let triTested = 0;
    let triHits = 0;
    if (layersOK && spherePass && bboxPass) {
      const posAttr = geo.attributes.position;
      const idx = geo.index;
      const maxTri = Math.min(
        idx ? Math.floor(idx.count / 3) : Math.floor(posAttr.count / 3),
        200,
      );
      const tA = new THREE.Vector3(),
        tB = new THREE.Vector3(),
        tC = new THREE.Vector3();
      const hitPt = new THREE.Vector3();
      for (let t = 0; t < maxTri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        tA.fromBufferAttribute(posAttr, i0);
        tB.fromBufferAttribute(posAttr, i1);
        tC.fromBufferAttribute(posAttr, i2);
        if (localRay.intersectTriangle(tA, tB, tC, false, hitPt)) triHits++;
        triTested++;
      }
    }

    // Log all gates
    const bboxSize = geo.boundingBox
      ? geo.boundingBox.getSize(new THREE.Vector3())
      : null;
    const bboxStr = bboxSize
      ? `(${bboxSize.x.toFixed(2)} x ${bboxSize.y.toFixed(2)} x ${bboxSize.z.toFixed(2)})`
      : "null";
    const worldPos = new THREE.Vector3().setFromMatrixColumn(
      mesh.matrixWorld,
      3,
    );

    const gateStr = [
      `layers=${layersOK ? "OK" : "%cFAIL%c"}`,
      `sphere_gate=${spherePass ? "PASS" : "%cFAIL%c"}`,
      `bbox_gate=${bboxPass ? "PASS" : "%cFAIL%c"}`,
      `bvh_root=${bvhRootPass ? "PASS" : "%cFAIL%c"}`,
    ].join(" ");

    const failCount = [layersOK, spherePass, bboxPass, bvhRootPass].filter(
      (v) => !v,
    ).length;
    const styles: string[] = [];
    if (!layersOK) {
      styles.push("color:#f00;font-weight:bold", "");
    }
    if (!spherePass) {
      styles.push("color:#f00;font-weight:bold", "");
    }
    if (!bboxPass) {
      styles.push("color:#f00;font-weight:bold", "");
    }
    if (!bvhRootPass) {
      styles.push("color:#f00;font-weight:bold", "");
    }

    if (failCount > 0) {
      console.log(
        `    %c${mesh.name} (${inst}):%c ${gateStr}  bbox=${bboxStr}`,
        "color:#ff0;font-weight:bold",
        "",
        ...styles,
      );
    } else {
      console.log(`    ${mesh.name} (${inst}): ${gateStr}  bbox=${bboxStr}`);
    }
    console.log(
      `      localRayOrig=(${localRay.origin.x.toFixed(2)}, ${localRay.origin.y.toFixed(2)}, ${localRay.origin.z.toFixed(2)})  localRayDir=(${localRay.direction.x.toFixed(4)}, ${localRay.direction.y.toFixed(4)}, ${localRay.direction.z.toFixed(4)})`,
    );
    console.log(
      `      worldPos=(${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)}, ${worldPos.z.toFixed(2)})  stale=${mesh.matrixWorldNeedsUpdate}  autoUpdate=${mesh.matrixAutoUpdate}`,
    );
    if (layersOK && spherePass && bboxPass) {
      console.log(
        `      tri_sample: ${triHits}/${triTested} triangles hit by local ray`,
      );
    }

    if (missedMeshBoxes.length < 3 && geo.boundingBox) {
      const worldBox = geo.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      missedMeshBoxes.push({ mesh, worldBox });
    }
  }
  console.log(
    `  Ray passes through ${sphereHitCount} mesh bounding spheres, ${missCount} pipeline misses`,
  );

  // 6b. Add wireframe Box3Helpers for missed meshes
  for (const { worldBox } of missedMeshBoxes) {
    const helper = new THREE.Box3Helper(worldBox, new THREE.Color(0xff00ff));
    ctx.scene.add(helper);
    ctx.debugObjects.push(helper);
  }

  // 7. Visualise hits
  const HIT_COLORS = [0x00ff00, 0xffff00, 0xff8800, 0xff0000, 0xff00ff];

  filtered.slice(0, 5).forEach((h, i) => {
    ctx.addDebugSphere(
      h.point,
      HIT_COLORS[Math.min(i, HIT_COLORS.length - 1)],
      sphereSize * (i === 0 ? 1.5 : 1),
    );
    const inst = instanceName(h.object);
    console.log(
      `  %cFiltered[${i}]%c d=${h.distance.toFixed(4)} instance="${inst}" faceIdx=${h.faceIndex ?? "?"} normal=(${h.face!.normal.x.toFixed(2)},${h.face!.normal.y.toFixed(2)},${h.face!.normal.z.toFixed(2)})`,
      `color:${["#0f0", "#ff0", "#f80", "#f00", "#f0f"][Math.min(i, 4)]}`,
      "",
    );
  });

  if (filtered.length === 0) {
    console.log(
      "  %cNO VALID HIT — the ray missed all visible geometry",
      "color:#f00;font-weight:bold",
    );
    ctx.addDebugSphere(visEnd, 0xff0000, sphereSize * 2);
  }

  console.log(
    "%c[Raycast Debug] ════════════════════════════════════════",
    "color:#0af",
  );
}
