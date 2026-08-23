import { RACES } from './types';

/** Default similarity threshold below which a race match is considered unreliable (see matchRace). */
export const RACE_MATCH_THRESHOLD = 0.82;

/**
 * Classic Jaro similarity (0..1): fraction of matching characters within a sliding window, adjusted
 * for transpositions among the matched characters.
 */
function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const len1 = a.length;
  const len2 = b.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const aMatches = new Array<boolean>(len1).fill(false);
  const bMatches = new Array<boolean>(len2).fill(false);
  let matches = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  return (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler similarity (0..1): Jaro similarity boosted for strings sharing a common prefix (up
 * to 4 characters), which suits short, prefix-stable labels like Blood Bowl race names much better
 * than plain edit distance (e.g. "Human" vs "Humans" or a truncated/misspelled tail scores high;
 * a completely different race name doesn't).
 */
export function jaroWinklerSimilarity(a: string, b: string, prefixScale = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  const maxPrefix = 4;
  let prefixLength = 0;
  for (let i = 0; i < Math.min(maxPrefix, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefixLength++;
  }
  return jaro + prefixLength * prefixScale * (1 - jaro);
}

export interface RaceMatch {
  race: (typeof RACES)[number];
  score: number;
}

/**
 * Finds the closest official race name for a free-text input (e.g. from a pasted CSV), using
 * case/whitespace-insensitive Jaro-Winkler similarity against every entry in `RACES`. Returns null
 * when even the best match falls below `threshold` — better to flag "race not recognised" for a
 * human to resolve than to silently guess wrong.
 */
export function matchRace(input: string, threshold = RACE_MATCH_THRESHOLD): RaceMatch | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;

  let best: RaceMatch | null = null;
  for (const race of RACES) {
    const score = jaroWinklerSimilarity(normalized, race.toLowerCase());
    if (!best || score > best.score) best = { race, score };
  }
  return best && best.score >= threshold ? best : null;
}
