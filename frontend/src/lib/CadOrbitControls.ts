import * as THREE from "three";

const _q = new THREE.Quaternion();
const _qH = new THREE.Quaternion();
const _qV = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _eye = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _desiredUp = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _WORLD_Y = new THREE.Vector3(0, 1, 0);

/**
 * CAD-style orbit controls with two rotation modes and built-in pan.
 *
 * **Trackball** (`turntable = false`, default) — camera-local axes, quaternion-
 * based, no lookAt. Eliminates snap artifacts when changing the orbit pivot.
 *
 * **Turntable** (`turntable = true`) — azimuth around world Y, elevation
 * around camera right, free pole traversal with an up-vector flip.
 *
 * Replaces TrackballControls for both rotation and pan.
 */
export class CadOrbitControls extends THREE.EventDispatcher<{ change: {} }> {
  readonly target = new THREE.Vector3();

  rotateSpeed = 0.007; // radians per pixel
  panSpeed = 1.0;

  minDistance = 0.001;
  maxDistance = Infinity;

  /** When false, all orbit/pan input is ignored. */
  enabled = true;

  /**
   * When true, horizontal drag orbits around world Y (turntable / model-space
   * up). The camera passes freely through the poles with an up-vector flip.
   * When false (default), both axes use camera-local directions (trackball).
   */
  turntable = false;

  private _camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private _domElement: HTMLElement;

  private _rotateActive = false;
  private _panActive = false;
  private _lastRotatePointer = new THREE.Vector2();
  private _lastPanPointer = new THREE.Vector2();

  private _disposed = false;

  constructor(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    domElement: HTMLElement,
  ) {
    super();
    this._camera = camera;
    this._domElement = domElement;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._camera;
  }

  set camera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    this._camera = cam;
  }

  /**
   * No-op kept for call-site compatibility after external camera mutations
   * (fitToModel, gizmo animation, restoreCameraState, zoom, etc.).
   * Both rotation modes are fully incremental — the camera's own
   * position/quaternion ARE the state.
   */
  syncFromCamera(): void {}

  /**
   * Change the orbit pivot without moving or reorienting the camera.
   * No snap — the next orbit simply rotates around the new center.
   */
  setOrbitCenter(point: THREE.Vector3): void {
    this.target.copy(point);
  }

  // ---------------------------------------------------------------------------
  // Rotation  (screen-space axes, quaternion-based, no lookAt)
  // ---------------------------------------------------------------------------

  startRotate(clientX: number, clientY: number): void {
    if (!this.enabled) return;
    this._rotateActive = true;
    this._lastRotatePointer.set(clientX, clientY);
  }

  /** Returns true if a rotation update was applied. */
  rotateByPointer(clientX: number, clientY: number): boolean {
    if (!this._rotateActive || !this.enabled) return false;

    const dx = clientX - this._lastRotatePointer.x;
    const dy = clientY - this._lastRotatePointer.y;
    this._lastRotatePointer.set(clientX, clientY);

    if (dx === 0 && dy === 0) return false;

    const cam = this._camera;
    _right.setFromMatrixColumn(cam.matrixWorld, 0);

    if (this.turntable) {
      this._rotateTurntable(cam, dx, dy);
    } else {
      this._rotateScreenSpace(cam, dx, dy);
    }

    // Keep cam.up in sync so code that reads it (switchProjection, etc.) sees
    // the actual camera Y-axis rather than a stale initial value.
    cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    cam.quaternion.normalize();
    cam.updateWorldMatrix(false, false);
    this.dispatchEvent({ type: "change" });
    return true;
  }

  /** Screen-space (trackball) rotation: both axes camera-local, no lookAt. */
  private _rotateScreenSpace(
    cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    dx: number,
    dy: number,
  ): void {
    _up.setFromMatrixColumn(cam.matrixWorld, 1);

    _qH.setFromAxisAngle(_up, -dx * this.rotateSpeed);
    _qV.setFromAxisAngle(_right, -dy * this.rotateSpeed);
    _q.copy(_qH).multiply(_qV);

    _eye.subVectors(cam.position, this.target);
    _eye.applyQuaternion(_q);
    cam.position.copy(this.target).add(_eye);

    cam.quaternion.premultiply(_q);
  }

  /**
   * Turntable rotation: world-Y azimuth, camera-right elevation, free pole
   * traversal.  Uses the same quaternion-premultiply pipeline as trackball
   * (no lookAt) with a damped roll-only correction that levels the horizon
   * without changing where the camera is looking.
   */
  private _rotateTurntable(
    cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    dx: number,
    dy: number,
  ): void {
    // Build rotation: world-Y horizontal, camera-right vertical.
    // No azimuth sign flip — left always rotates CCW around Y.
    _qH.setFromAxisAngle(_WORLD_Y, -dx * this.rotateSpeed);
    _qV.setFromAxisAngle(_right, -dy * this.rotateSpeed);
    _q.copy(_qH).multiply(_qV);

    // Apply to position and orientation (same as trackball — no lookAt)
    _eye.subVectors(cam.position, this.target);
    _eye.applyQuaternion(_q);
    cam.position.copy(this.target).add(_eye);
    cam.quaternion.premultiply(_q);

    // --- Roll-only correction: level the horizon without repointing ---
    _forward.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const poleProximity = Math.abs(_forward.dot(_WORLD_Y));

    // Smooth fade: full correction away from poles, zero at poles
    const FADE_START = 0.85;
    const FADE_END = 0.99;
    const fade =
      poleProximity <= FADE_START
        ? 1
        : poleProximity >= FADE_END
          ? 0
          : 1 - (poleProximity - FADE_START) / (FADE_END - FADE_START);

    const strength = fade * 0.5;

    if (strength > 1e-4) {
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion);

      // Reference up: world Y or -Y based on current camera orientation
      _desiredUp.set(0, _up.y >= 0 ? 1 : -1, 0);

      // Project onto the plane perpendicular to the look direction
      _desiredUp.addScaledVector(_forward, -_forward.dot(_desiredUp));
      const len = _desiredUp.length();

      if (len > 1e-4) {
        _desiredUp.divideScalar(len);

        const dot = THREE.MathUtils.clamp(_up.dot(_desiredUp), -1, 1);
        if (dot < 0.99999) {
          _cross.crossVectors(_up, _desiredUp);
          const fullAngle = Math.atan2(_cross.dot(_forward), dot);
          _qRoll.setFromAxisAngle(_forward, fullAngle * strength);
          cam.quaternion.premultiply(_qRoll);
        }
      }
    }
  }

  endRotate(): void {
    this._rotateActive = false;
  }

  get isRotating(): boolean {
    return this._rotateActive;
  }

  /** Reset the rotation tracking origin (e.g. after pivot commit). */
  resetRotateOrigin(clientX: number, clientY: number): void {
    this._lastRotatePointer.set(clientX, clientY);
  }

  // ---------------------------------------------------------------------------
  // Pan
  // ---------------------------------------------------------------------------

  startPan(clientX: number, clientY: number): void {
    if (!this.enabled) return;
    this._panActive = true;
    this._lastPanPointer.set(clientX, clientY);
  }

  /** Returns true if a pan update was applied. */
  panByPointer(clientX: number, clientY: number): boolean {
    if (!this._panActive || !this.enabled) return false;

    const dx = clientX - this._lastPanPointer.x;
    const dy = clientY - this._lastPanPointer.y;
    this._lastPanPointer.set(clientX, clientY);

    if (dx === 0 && dy === 0) return false;

    const cam = this._camera;
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);

    const pixelToWorld = this._pixelToWorld();

    _delta.set(0, 0, 0);
    _delta.addScaledVector(_right, -dx * pixelToWorld * this.panSpeed);
    _delta.addScaledVector(_up, dy * pixelToWorld * this.panSpeed);

    cam.position.add(_delta);
    this.target.add(_delta);

    cam.updateWorldMatrix(false, false);
    this.dispatchEvent({ type: "change" });
    return true;
  }

  endPan(): void {
    this._panActive = false;
  }

  get isPanning(): boolean {
    return this._panActive;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** Conversion factor: how many world-units one screen pixel represents. */
  private _pixelToWorld(): number {
    const cam = this._camera;
    const el = this._domElement;
    const height = el.clientHeight || 1;

    if (cam instanceof THREE.PerspectiveCamera) {
      const distance = cam.position.distanceTo(this.target);
      return (
        (2 * distance * Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5))) /
        height
      );
    }

    const ortho = cam as THREE.OrthographicCamera;
    return (ortho.top - ortho.bottom) / ortho.zoom / height;
  }

  /** No-op — state is applied immediately during pointer methods. */
  update(): void {}

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._rotateActive = false;
    this._panActive = false;
  }
}
