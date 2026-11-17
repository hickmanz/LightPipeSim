/**
 * Viewport Gizmo - A Three.js orientation triad rendered in a corner viewport.
 *
 * Renders a clickable XYZ axis indicator that syncs with the main camera orientation.
 * Clicking an axis smoothly animates the camera to that standard view.
 *
 * Inspired by @react-three/drei GizmoHelper/GizmoViewport, rebuilt for vanilla Three.js.
 */
import * as THREE from "three";
import type { ShallowRef, Ref } from "vue";

/** Minimal control interface needed by the viewport gizmo. */
interface GizmoCompatibleControls {
  target: THREE.Vector3;
  dispose(): void;
}

export interface ViewportGizmoOptions {
  renderer: ShallowRef<THREE.WebGLRenderer | null>;
  camera: ShallowRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>;
  controls: ShallowRef<GizmoCompatibleControls | null>;
  canvasRef: Ref<HTMLCanvasElement | null>;
  /** Pixel size of the gizmo viewport (default: 120) */
  size?: number;
  /** [right, bottom] margin in CSS pixels (default: [16, 16]) */
  margin?: [number, number];
  /** Callback fired when animation completes */
  onAnimationComplete?: () => void;
  /** Callback to request controls be recreated (for clean state) */
  onRequestControlsRecreate?: () => void;
  /** When true, the gizmo will not change the canvas cursor */
  cursorLocked?: Ref<boolean>;
}

// ---------------------------------------------------------------------------
// Reusable temporaries – avoid per-frame allocations
// ---------------------------------------------------------------------------
const _matrix = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _targetPosition = new THREE.Vector3();
const _focusPoint = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();
const _rendererSize = new THREE.Vector2();

const TURN_RATE = 2 * Math.PI; // radians per second for camera tween
const ANIM_THRESHOLD = 0.01; // quaternion angle threshold to stop animation
const DEFAULT_UP = new THREE.Vector3(0, 1, 0);

// Axis definitions
const AXES: { dir: THREE.Vector3; color: number; label: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff2060, label: "X" },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x20df80, label: "Y" },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x2080ff, label: "Z" },
];

// Sprite base scales (positive head vs negative dot)
const SCALE_POS = 0.5;
const SCALE_NEG = 0.3;
const HOVER_FACTOR = 1.2;

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useViewportGizmo(options: ViewportGizmoOptions) {
  const {
    renderer: rendererRef,
    camera: cameraRef,
    controls: controlsRef,
    canvasRef,
    size: gizmoSize = 180,
    margin = [16, 16],
    onAnimationComplete,
    onRequestControlsRecreate,
  } = options;

  // ---- Gizmo scene & camera ------------------------------------------------

  const gizmoScene = new THREE.Scene();

  // Orthographic camera fixed at +Z looking at origin
  const gizmoCamera = new THREE.OrthographicCamera(
    -1.8,
    1.8,
    1.8,
    -1.8,
    0.1,
    10,
  );
  gizmoCamera.position.set(0, 0, 3);
  gizmoCamera.lookAt(0, 0, 0);

  // Root group – its quaternion is synced with the inverse main camera matrix
  const gizmoGroup = new THREE.Group();
  gizmoScene.add(gizmoGroup);

  // ---- Interaction state ----------------------------------------------------

  const clickableHeads: THREE.Sprite[] = [];
  const headDirections = new Map<THREE.Object3D, THREE.Vector3>();
  let hoveredSprite: THREE.Sprite | null = null;
  let gizmoCursorActive = false;

  // ---- Tween state ----------------------------------------------------------

  let animating = false;
  let tweenRadius = 0;

  // ---- Build geometry -------------------------------------------------------

  buildGizmoGeometry();

  // ---- Geometry builders ----------------------------------------------------

  function buildGizmoGeometry() {
    // Small center sphere
    const centerGeo = new THREE.SphereGeometry(0.07, 16, 16);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0xbbbbbb,
      toneMapped: false,
    });
    gizmoGroup.add(new THREE.Mesh(centerGeo, centerMat));

    for (const axis of AXES) {
      // --- Simple line from origin to the positive sprite position ---
      const lineEnd = axis.dir.clone().multiplyScalar(1.05);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        lineEnd,
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: axis.color,
        toneMapped: false,
      });
      gizmoGroup.add(new THREE.Line(lineGeo, lineMat));

      // --- Positive axis head (labeled sprite, clickable) ---
      const posSprite = createAxisSprite(axis.label, axis.color, true);
      posSprite.position.copy(axis.dir).multiplyScalar(1.05);
      gizmoGroup.add(posSprite);
      clickableHeads.push(posSprite);
      headDirections.set(posSprite, axis.dir.clone());

      // --- Negative axis head (small dot, clickable) ---
      const negSprite = createAxisSprite("", axis.color, false);
      negSprite.position.copy(axis.dir).multiplyScalar(-1);
      gizmoGroup.add(negSprite);
      clickableHeads.push(negSprite);
      headDirections.set(negSprite, axis.dir.clone().negate());
    }
  }

  /** Create a canvas-based sprite for an axis head or negative dot. */
  function createAxisSprite(
    label: string,
    color: number,
    isPositive: boolean,
  ): THREE.Sprite {
    const px = 64;
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d")!;

    // Filled circle
    const colorStr = "#" + new THREE.Color(color).getHexString();
    const radius = isPositive ? 20 : 12;
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, radius, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = colorStr;
    ctx.fill();

    // Label text
    if (label) {
      ctx.font = "bold 20px Inter, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000000";
      ctx.fillText(label, px / 2, px / 2 + 1);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      alphaTest: 0.3,
      opacity: isPositive ? 1 : 0.6,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(isPositive ? SCALE_POS : SCALE_NEG);
    sprite.renderOrder = 10;
    sprite.userData.isPositive = isPositive;
    return sprite;
  }

  // ---- Screen-space helpers -------------------------------------------------

  /** Gizmo bounding rect in CSS pixels (top-left origin, like DOM). */
  function getScreenRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null {
    const canvas = canvasRef.value;
    if (!canvas) return null;
    return {
      left: canvas.clientWidth - gizmoSize - margin[0],
      top: canvas.clientHeight - gizmoSize - margin[1],
      width: gizmoSize,
      height: gizmoSize,
    };
  }

  /** True when pointer coordinates fall inside the gizmo viewport. */
  function isPointerInGizmo(event: PointerEvent | MouseEvent): boolean {
    const rect = getScreenRect();
    if (!rect) return false;
    const canvas = canvasRef.value!;
    const cr = canvas.getBoundingClientRect();
    const rx = event.clientX - cr.left;
    const ry = event.clientY - cr.top;
    return (
      rx >= rect.left &&
      rx <= rect.left + rect.width &&
      ry >= rect.top &&
      ry <= rect.top + rect.height
    );
  }

  /** Map a pointer event to gizmo-local NDC [-1, 1]. */
  function toGizmoNDC(event: PointerEvent | MouseEvent): THREE.Vector2 | null {
    const rect = getScreenRect();
    if (!rect) return null;
    const canvas = canvasRef.value!;
    const cr = canvas.getBoundingClientRect();
    const localX = event.clientX - cr.left - rect.left;
    const localY = event.clientY - cr.top - rect.top;
    _pointer.set(
      (localX / rect.width) * 2 - 1,
      -(localY / rect.height) * 2 + 1,
    );
    return _pointer;
  }

  // ---- Camera tween ---------------------------------------------------------

  function tweenCamera(direction: THREE.Vector3) {
    const camera = cameraRef.value;
    const controls = controlsRef.value;
    if (!camera) return;

    // If already animating, just update the target (don't restart)
    if (animating) {
      _targetPosition
        .copy(direction)
        .multiplyScalar(tweenRadius)
        .add(_focusPoint);
      _dummy.position.copy(_targetPosition);

      if (Math.abs(direction.y) > 0.99) {
        _dummy.up.set(0, 0, direction.y > 0 ? -1 : 1);
      } else {
        _dummy.up.copy(DEFAULT_UP);
      }

      _dummy.lookAt(_focusPoint);
      _q2.copy(_dummy.quaternion);
      return;
    }

    animating = true;

    // Dispose controls completely to prevent ANY state accumulation
    if (controls) {
      controls.dispose();
      controlsRef.value = null;
    }

    // Focus point = current orbit target
    _focusPoint.copy(controls?.target ?? new THREE.Vector3(0, 0, 0));
    tweenRadius = camera.position.distanceTo(_focusPoint);

    // Source: current camera orientation
    _q1.copy(camera.quaternion);

    // Target: camera positioned along `direction` from focus, looking at focus
    _targetPosition
      .copy(direction)
      .multiplyScalar(tweenRadius)
      .add(_focusPoint);
    _dummy.position.copy(_targetPosition);

    // Handle degenerate case: direction parallel to default up (top / bottom)
    if (Math.abs(direction.y) > 0.99) {
      _dummy.up.set(0, 0, direction.y > 0 ? -1 : 1);
    } else {
      _dummy.up.copy(DEFAULT_UP);
    }

    _dummy.lookAt(_focusPoint);
    _q2.copy(_dummy.quaternion);
  }

  // ---- Public API -----------------------------------------------------------

  /**
   * Advance tween animation. Call every frame **before** controls.update().
   * @param delta seconds since last frame
   */
  function update(delta: number) {
    if (!animating) return;

    const camera = cameraRef.value;
    if (!camera) {
      animating = false;
      return;
    }

    // Finished?
    if (_q1.angleTo(_q2) < ANIM_THRESHOLD) {
      animating = false;

      // Snap to exact target orientation (avoid floating-point drift)
      camera.position
        .set(0, 0, 1)
        .applyQuaternion(_q2)
        .multiplyScalar(tweenRadius)
        .add(_focusPoint);
      camera.quaternion.copy(_q2);
      camera.up.set(0, 1, 0).applyQuaternion(_q2).normalize();

      // CRITICAL: Update camera matrices after manually setting position/quaternion
      camera.updateMatrix();
      camera.updateMatrixWorld(true);

      // Recreate controls with clean state
      if (onRequestControlsRecreate) {
        onRequestControlsRecreate();
      }

      // Set correct orbit target on the newly created controls
      if (controlsRef.value) {
        controlsRef.value.target.copy(_focusPoint);
      }

      // Notify listener that animation completed
      if (onAnimationComplete) onAnimationComplete();

      return;
    }

    // Slerp one step
    const step = delta * TURN_RATE;
    _q1.rotateTowards(_q2, step);

    // Apply to main camera
    camera.position
      .set(0, 0, 1)
      .applyQuaternion(_q1)
      .multiplyScalar(tweenRadius)
      .add(_focusPoint);
    camera.up.set(0, 1, 0).applyQuaternion(_q1).normalize();
    camera.quaternion.copy(_q1);

    // Update matrices every frame during animation
    camera.updateMatrix();
    camera.updateMatrixWorld(true);
  }

  /**
   * Render the gizmo overlay. Call **after** the main scene render each frame.
   */
  function render() {
    const renderer = rendererRef.value;
    const camera = cameraRef.value;
    if (!renderer || !camera) return;
    if (!canvasRef.value) return;

    // Sync gizmo orientation with main camera
    _matrix.copy(camera.matrix).invert();
    gizmoGroup.quaternion.setFromRotationMatrix(_matrix);

    // Renderer CSS pixel size
    renderer.getSize(_rendererSize);
    const w = _rendererSize.x;
    const h = _rendererSize.y;

    // Viewport position – WebGL origin is bottom-left
    const gx = w - gizmoSize - margin[0];
    const gy = margin[1]; // distance from bottom

    // ---- Save renderer state ----
    const prevAutoClear = renderer.autoClear;

    // ---- Render gizmo into corner viewport ----
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(gx, gy, gizmoSize, gizmoSize);
    renderer.setViewport(gx, gy, gizmoSize, gizmoSize);

    // Only clear depth so main scene shows through (transparent background)
    renderer.clearDepth();

    renderer.render(gizmoScene, gizmoCamera);

    // ---- Restore renderer state ----
    renderer.autoClear = prevAutoClear;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }

  /**
   * Handle pointer down. Returns `true` if the gizmo consumed the event.
   */
  function handlePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) return false;
    // Block all left clicks while the tween is running
    if (animating) return true;
    if (!isPointerInGizmo(event)) return false;

    const ndc = toGizmoNDC(event);
    if (!ndc) return false;

    _raycaster.setFromCamera(ndc, gizmoCamera);
    const intersects = _raycaster.intersectObjects(clickableHeads);

    if (intersects.length > 0) {
      const direction = headDirections.get(intersects[0].object);
      if (direction) tweenCamera(direction);
    }

    return true; // consumed – click is in gizmo area
  }

  /**
   * Handle pointer move for hover feedback. Returns `true` if pointer is
   * inside the gizmo viewport.
   */
  function handlePointerMove(event: PointerEvent | MouseEvent): boolean {
    if (!isPointerInGizmo(event)) {
      if (hoveredSprite) resetHover();
      return false;
    }

    const ndc = toGizmoNDC(event);
    if (!ndc) return false;

    _raycaster.setFromCamera(ndc, gizmoCamera);
    const intersects = _raycaster.intersectObjects(clickableHeads);

    // Reset previous hover
    if (hoveredSprite) {
      restoreSpriteScale(hoveredSprite);
      hoveredSprite = null;
    }

    if (intersects.length > 0) {
      hoveredSprite = intersects[0].object as THREE.Sprite;
      const isPos = hoveredSprite.userData.isPositive as boolean;
      hoveredSprite.scale.setScalar(
        (isPos ? SCALE_POS : SCALE_NEG) * HOVER_FACTOR,
      );
      setGizmoCursor("pointer");
    } else {
      setGizmoCursor("");
    }

    return true;
  }

  // ---- Internal helpers -----------------------------------------------------

  function resetHover() {
    if (hoveredSprite) {
      restoreSpriteScale(hoveredSprite);
      hoveredSprite = null;
    }
    setGizmoCursor("");
  }

  function restoreSpriteScale(sprite: THREE.Sprite) {
    const isPos = sprite.userData.isPositive as boolean;
    sprite.scale.setScalar(isPos ? SCALE_POS : SCALE_NEG);
  }

  function setGizmoCursor(cursor: string) {
    const canvas = canvasRef.value;
    if (!canvas) return;
    if (options.cursorLocked?.value) return;
    if (cursor) {
      canvas.style.cursor = cursor;
      gizmoCursorActive = true;
    } else if (gizmoCursorActive) {
      canvas.style.cursor = "";
      gizmoCursorActive = false;
    }
  }

  /**
   * Dispose all gizmo GPU resources.
   */
  function dispose() {
    gizmoScene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        mats.forEach((m) => m.dispose());
      }
      if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    });
    clickableHeads.length = 0;
    headDirections.clear();
  }

  // ---- Return public API ----------------------------------------------------

  return {
    /** Advance tween animation (call before controls.update each frame) */
    update,
    /** Render gizmo overlay (call after main scene render each frame) */
    render,
    /** Handle pointer down – returns true if consumed */
    handlePointerDown,
    /** Handle pointer move for hover – returns true if in gizmo area */
    handlePointerMove,
    /** Dispose GPU resources */
    dispose,
    /** Test if a pointer event is inside the gizmo viewport */
    isPointerInGizmo,
    /** True while the gizmo is animating the camera to a standard view */
    get isAnimating() {
      return animating;
    },
  };
}
