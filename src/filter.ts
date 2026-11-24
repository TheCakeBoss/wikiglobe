import { LARGE_DIM_METRES, LARGE_TYPES } from './config';
import type { Place } from './wiki';

/** Countries, continents and anything with a very large `dim`. */
export function isLargeRegion(p: Place): boolean {
  if (p.type && LARGE_TYPES.has(p.type.toLowerCase())) return true;
  return (p.dim ?? 0) >= LARGE_DIM_METRES;
}

export function filterPlaces(places: Place[], showLarge: boolean): Place[] {
  return showLarge ? places : places.filter((p) => !isLargeRegion(p));
}
