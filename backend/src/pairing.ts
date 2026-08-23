import type { Challenge, Tournament } from '@bb-tournament/shared';
import { forbidden } from './errors';

export function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function buildPriorOpponents(challenges: Challenge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
  };
  for (const ch of challenges) {
    if (ch.status !== 'completed') continue;
    add(ch.team1Id, ch.team2Id);
    add(ch.team2Id, ch.team1Id);
  }
  return map;
}

/** Pairs teams in the given order, walking forward and preferring an opponent not already played. */
export function pairInOrder(orderedIds: string[], priorOpponents: Map<string, Set<string>>): [string, string][] {
  const pairs: [string, string][] = [];
  const used = new Set<string>();
  for (let i = 0; i < orderedIds.length; i++) {
    const a = orderedIds[i];
    if (used.has(a)) continue;
    used.add(a);

    let opponent: string | null = null;
    for (let j = i + 1; j < orderedIds.length; j++) {
      const b = orderedIds[j];
      if (used.has(b)) continue;
      if (!priorOpponents.get(a)?.has(b)) {
        opponent = b;
        break;
      }
    }
    if (!opponent) {
      // No rematch-free opponent left: fall back to the nearest unused team.
      for (let j = i + 1; j < orderedIds.length; j++) {
        const b = orderedIds[j];
        if (!used.has(b)) {
          opponent = b;
          break;
        }
      }
    }
    if (opponent) {
      used.add(opponent);
      pairs.push([a, opponent]);
    }
  }
  return pairs;
}

/** Throws unless the most recently generated round (if any) has every match completed. */
export function assertPreviousRoundComplete(t: Tournament, roundNumber: number): void {
  if (roundNumber <= 1) return;
  const previousRoundNumber = t.rounds[t.rounds.length - 1].number;
  const previousChallenges = t.challenges.filter((c) => c.round === previousRoundNumber);
  if (!previousChallenges.every((c) => c.status === 'completed')) {
    throw forbidden(`Round ${previousRoundNumber} is not finished yet`, 'previous_round_unfinished');
  }
}
