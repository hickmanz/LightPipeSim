declare module "three-mesh-bvh" {
  import type { Raycaster, Intersection } from "three";
  export class MeshBVH {
    constructor(geometry: unknown, options?: unknown);
    shapecast(options: unknown): void;
  }
  export function acceleratedRaycast(
    raycaster: Raycaster,
    intersects: Intersection[],
  ): void;
  export const CENTER: number;
  export const AVERAGE: number;
  export const SAH: number;
}
