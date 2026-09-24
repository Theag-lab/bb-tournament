import { RACES } from './types';

/** Default similarity threshold below which a race match is considered unreliable (see matchRace). */
export const RACE_MATCH_THRESHOLD = 0.82;

/**
 * Official French roster labels, as used by the French-speaking NAF/Blood Bowl community —
 * checked alongside the English `RACES` names so a pasted CSV in French (e.g. "Nains", "Orques
 * Noir") resolves correctly instead of scoring low against every English label via Jaro-Winkler
 * alone (a plain string-similarity metric can't bridge "Nains" to "Dwarf", they share no
 * structure at all).
 */
export const FRENCH_RACE_LABELS: Record<(typeof RACES)[number], string> = {
  Amazon: 'Amazones',
  'Black Orc': 'Orques Noir',
  Bretonnia: 'Bretonnien',
  'Chaos Chosen': 'Élue du Chaos',
  'Chaos Dwarf': 'Nain du Chaos',
  'Chaos Renegade': 'Renégats du Chaos',
  'Dark Elf': 'Elfes Noir',
  Dwarf: 'Nains',
  'Elven Union': 'Union Elfique',
  Gnomes: 'Gnomes',
  Goblins: 'Gobelins',
  Halflings: 'Halflings',
  'High Elf': 'Hauts Elfes',
  Human: 'Humains',
  'Imperial Nobility': 'Noblesse Impériale',
  Khorne: 'Khorne',
  Lizardmen: 'Hommes-Lézard',
  'Necromantic Horror': 'Horreur Nécromantiques',
  Norse: 'Nordiques',
  Nurgle: 'Nurgle',
  Ogres: 'Ogres',
  'Old World Alliance': 'Alliance du Vieux Monde',
  Orc: 'Orques',
  'Shambling Undead': 'Morts-Vivants',
  Skaven: 'Skavens',
  Slann: 'Slann',
  Snotlings: 'Snotlings',
  'Tomb Kings': 'Rois des Tombes',
  'Underworld Denizens': 'Bas Fonds',
  Vampire: 'Vampires',
  'Wood Elf': 'Elfes Sylvain',
};

/**
 * Community-standard NAF/roster abbreviations, checked as an exact (case/accent-insensitive)
 * match before fuzzy matching kicks in — these are too short for Jaro-Winkler to reliably tell
 * apart (e.g. "MV" shares almost no structure with "Shambling Undead") so they need their own
 * lookup rather than just scoring higher against the right race name.
 */
export const RACE_ABBREVIATIONS: Record<string, (typeof RACES)[number]> = {
  we: 'Wood Elf',
  es: 'Wood Elf', // "Elfes Sylvain"
  de: 'Dark Elf',
  owa: 'Old World Alliance',
  mv: 'Shambling Undead',
  he: 'High Elf',
  ue: 'Elven Union',
  bo: 'Black Orc',
  on: 'Black Orc', // "Orcs Noirs"
};

/** Lowercased, accent-stripped, trimmed — so "Élue"/"Elue", "Ecole"/"École"-style CSV encoding
 * quirks and case differences never affect matching, in either language. */
function normalizeForMatching(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

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
 * accent/case/whitespace-insensitive Jaro-Winkler similarity against every entry in `RACES` *and*
 * its French label (`FRENCH_RACE_LABELS`) — an exact French name scores a perfect 1, and a French
 * typo still resolves via the same fuzzy matching as an English one. Returns null when even the
 * best match falls below `threshold` — better to flag "race not recognised" for a human to
 * resolve than to silently guess wrong.
 */
export function matchRace(input: string, threshold = RACE_MATCH_THRESHOLD): RaceMatch | null {
  const normalized = normalizeForMatching(input);
  if (!normalized) return null;

  const abbreviated = RACE_ABBREVIATIONS[normalized];
  if (abbreviated) return { race: abbreviated, score: 1 };

  let best: RaceMatch | null = null;
  for (const race of RACES) {
    for (const label of [race, FRENCH_RACE_LABELS[race]]) {
      const score = jaroWinklerSimilarity(normalized, normalizeForMatching(label));
      if (!best || score > best.score) best = { race, score };
    }
  }
  return best && best.score >= threshold ? best : null;
}
