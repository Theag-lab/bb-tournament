import { stableRandomKey } from './scoring';

/**
 * Full round-robin schedule for a set of team IDs (classic "circle method": team[0] stays fixed,
 * the rest rotate one position each round). Produces `teamIds.length - 1` rounds (or
 * `teamIds.length` after an implicit bye pad when the count is odd — one team sits out each round,
 * rotating), every team facing a different opponent each round with no repeat until the full cycle
 * completes. Crucially, the whole schedule is a pure function of pool membership, not match
 * results — no round depends on any other round's outcome, so every round can be computed and
 * generated upfront, letting fast coaches get ahead instead of the whole pool blocking on its
 * slowest match.
 */
export function roundRobinSchedule(teamIds: string[]): [string, string][][] {
  if (teamIds.length < 2) return [];
  const ids: (string | null)[] = teamIds.slice();
  if (ids.length % 2 !== 0) ids.push(null); // bye slot, rotates like any other seat
  const n = ids.length;
  const rounds: [string, string][][] = [];
  const arr = ids.slice();

  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);

    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop()!);
    arr.splice(0, arr.length, fixed, ...rest);
  }
  return rounds;
}

/**
 * Deterministic-but-effectively-random seat order for the round-robin, derived purely from the
 * team IDs (same stable-hash technique as computeStandings' final tiebreak) — so pairings aren't
 * just "registration order", while staying identical across repeated calls with no schedule to
 * persist anywhere.
 */
export function stableShuffledOrder(teamIds: string[]): string[] {
  return teamIds.slice().sort((a, b) => stableRandomKey(a) - stableRandomKey(b));
}

/**
 * The round-robin pairing for one specific round number (1-based) of a pool. Cycles back through
 * the schedule from the start if `roundNumber` exceeds a full round-robin's length — i.e. the
 * admin configured more pool rounds than there are opponents to face exactly once.
 */
export function roundRobinPairingForRound(teamIds: string[], roundNumber: number): [string, string][] {
  const schedule = roundRobinSchedule(stableShuffledOrder(teamIds));
  if (schedule.length === 0) return [];
  return schedule[(roundNumber - 1) % schedule.length];
}
