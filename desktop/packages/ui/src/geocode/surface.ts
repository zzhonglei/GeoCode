const CLOSED_SURFACES = new Set(['linear']);

export const withoutClosedSurfaces = <T extends { id: string }>(surfaces: readonly T[]): readonly T[] =>
  surfaces.filter((surface) => !CLOSED_SURFACES.has(surface.id));
