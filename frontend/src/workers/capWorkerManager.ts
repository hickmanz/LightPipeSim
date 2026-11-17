/**
 * Manager for cap geometry Web Worker communication.
 * Provides a Promise-based API for requesting cap geometry computation.
 */

import type * as THREE from "three";
import type {
  ToWorkerMessage,
  FromWorkerMessage,
  SerializedSegments,
  SerializedCapGeometry,
} from "./capWorker.types";

// Result type for createBufferGeometry
export type CapGeometryResult = {
  geometry: THREE.BufferGeometry;
  colors: number[];
} | null;

// Edge segment type (matches useThreeViewer)
type EdgeSegment = {
  start: THREE.Vector3;
  end: THREE.Vector3;
  colorIndex: number;
};

type PendingRequest = {
  resolve: (geometry: SerializedCapGeometry) => void;
  reject: (error: Error) => void;
};

export class CapWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 0;
  private isDisposed = false;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL("./capWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = this.handleMessage.bind(this);
      this.worker.onerror = this.handleError.bind(this);
    } catch (error) {
      console.error("[CapWorkerManager] Failed to create worker:", error);
      this.worker = null;
    }
  }

  private handleMessage(event: MessageEvent<FromWorkerMessage>): void {
    const message = event.data;
    const pending = this.pendingRequests.get(message.requestId);

    if (!pending) {
      // Request was cancelled or already handled
      return;
    }

    this.pendingRequests.delete(message.requestId);

    if (message.type === "result") {
      pending.resolve(message.geometry);
    } else if (message.type === "error") {
      pending.reject(new Error(message.message));
    }
  }

  private handleError(event: ErrorEvent): void {
    console.error("[CapWorkerManager] Worker error:", event.message);
    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      pending.reject(new Error(`Worker error: ${event.message}`));
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Serialize EdgeSegment array to flat Float32Array for efficient transfer.
   * Includes colorIds for per-segment color tracking.
   */
  serializeSegments(
    segments: EdgeSegment[],
    colors: number[],
  ): SerializedSegments {
    const data = new Float32Array(segments.length * 6);
    const colorIds = new Uint16Array(segments.length);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const offset = i * 6;
      data[offset] = seg.start.x;
      data[offset + 1] = seg.start.y;
      data[offset + 2] = seg.start.z;
      data[offset + 3] = seg.end.x;
      data[offset + 4] = seg.end.y;
      data[offset + 5] = seg.end.z;
      colorIds[i] = seg.colorIndex;
    }

    return { data, colorIds, count: segments.length, colors };
  }

  /**
   * Request cap geometry computation from the worker.
   * Returns the serialized geometry result.
   */
  async processSegments(
    segments: EdgeSegment[],
    colors: number[],
    plane: THREE.Plane,
  ): Promise<SerializedCapGeometry> {
    if (!this.worker || this.isDisposed) {
      throw new Error("Worker not available");
    }

    const requestId = this.nextRequestId++;
    const serializedSegments = this.serializeSegments(segments, colors);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      const message: ToWorkerMessage = {
        type: "processSegments",
        requestId,
        segments: serializedSegments,
        plane: {
          normal: [plane.normal.x, plane.normal.y, plane.normal.z],
          constant: plane.constant,
        },
      };

      // Transfer segment data and colorIds buffers for zero-copy
      this.worker!.postMessage(message, [
        serializedSegments.data.buffer,
        serializedSegments.colorIds.buffer,
      ]);
    });
  }

  /**
   * Create a THREE.BufferGeometry from the worker result.
   * Returns geometry with groups for multi-material rendering and the color palette.
   */
  createBufferGeometry(
    THREE: typeof import("three"),
    result: SerializedCapGeometry,
  ): CapGeometryResult {
    if (!result) {
      return null;
    }

    const geometry = new THREE.BufferGeometry();

    if (result.positions.length > 0) {
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(result.positions, 3),
      );
      geometry.setIndex(Array.from(result.indices));

      // Set normals (all face the same direction as the plane normal)
      const normals: number[] = [];
      const numVertices = result.positions.length / 3;
      for (let i = 0; i < numVertices; i++) {
        normals.push(result.normal[0], result.normal[1], result.normal[2]);
      }
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(normals, 3),
      );

      // Add geometry groups for multi-material rendering
      if (result.groups && result.groups.length > 0) {
        for (const group of result.groups) {
          geometry.addGroup(group.start, group.count, group.colorIndex);
        }
      }
    }

    return { geometry, colors: result.colors || [] };
  }

  /**
   * Cancel a pending request (result will be ignored when it arrives).
   */
  cancelRequest(requestId: number): void {
    this.pendingRequests.delete(requestId);
  }

  /**
   * Cancel all pending requests.
   */
  cancelAllRequests(): void {
    this.pendingRequests.clear();
  }

  /**
   * Check if the worker is available.
   */
  isAvailable(): boolean {
    return this.worker !== null && !this.isDisposed;
  }

  /**
   * Dispose of the worker and clean up resources.
   */
  dispose(): void {
    this.isDisposed = true;
    this.cancelAllRequests();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

// Singleton instance for the application
let instance: CapWorkerManager | null = null;

export const getCapWorkerManager = (): CapWorkerManager => {
  if (!instance) {
    instance = new CapWorkerManager();
  }
  return instance;
};

export const disposeCapWorkerManager = (): void => {
  if (instance) {
    instance.dispose();
    instance = null;
  }
};
