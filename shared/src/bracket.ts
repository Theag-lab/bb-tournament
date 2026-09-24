import { headToHeadWinner, stableRandomKey } from './scoring';
import type { Challenge, MatchResult, TiebreakerCriterion } from './types';

/** One pool's qualifiers for the knockout bracket, ranked best-first, already trimmed to qualifiersPerPool. */
export interface PoolQualifiers {
  poolId: string;
  teamIds: string[];
}

/**
 * Builds the overall bracket seed order from each pool's qualifiers: all pool winners (in pool
 * order) first, then all pool runners-up, then all 3rd-placed, etc. Keeping same-tier finishers
 * together (rather than interleaving a pool's own qualifiers) is what lets the high-vs-low
 * first-round pairing in `pairFirstKnockoutRound` naturally tend to avoid same-pool rematches.
 */
export function buildKnockoutSeeds(pools: PoolQualifiers[]): string[] {
  const maxTier = pools.reduce((max, p) => Math.max(max, p.teamIds.length), 0);
  const seeds: string[] = [];
  for (let tier = 0; tier < maxTier; tier++) {
    for (const pool of pools) {
      const teamId = pool.teamIds[tier];
      if (teamId !== undefined) seeds.push(teamId);
    }
  }
  return seeds;
}

/** How many byes are needed to pad `qualifierCount` up to the next power of two. */
export function computeByeCount(qualifierCount: number): number {
  if (qualifierCount <= 0) return 0;
  let bracketSize = 1;
  while (bracketSize < qualifierCount) bracketSize *= 2;
  return bracketSize - qualifierCount;
}

export interface FirstRoundPairing {
  byes: string[];
  pairs: [string, string][];
}

/**
 * Pairs the first knockout round from a seed list (best seed first): the top `computeByeCount`
 * seeds get a bye, the rest are paired strongest-vs-weakest among themselves (seed i vs seed
 * N-1-i). A best-effort local-swap pass then breaks up any pair that still shares a pool — not a
 * formal seeding guarantee, just a practical reduction of immediate pool rematches. A second pass
 * (`avoidRound2PoolClashes`) then does the same one round further out, since byes make it possible
 * for two same-pool qualifiers to dodge each other in round 1 only to meet in round 2 instead.
 */
export function pairFirstKnockoutRound(seeds: string[], poolOfTeam: Map<string, string>): FirstRoundPairing {
  const byeCount = computeByeCount(seeds.length);
  const byes = seeds.slice(0, byeCount);
  const remaining = seeds.slice(byeCount);
  const n = remaining.length;
  const pairs: [string, string][] = [];
  for (let i = 0; i < n / 2; i++) {
    pairs.push([remaining[i], remaining[n - 1 - i]]);
  }

  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    if (poolOfTeam.get(a) !== poolOfTeam.get(b)) continue;
    for (let j = 0; j < pairs.length; j++) {
      if (j === i) continue;
      const [c, d] = pairs[j];
      if (poolOfTeam.get(a) !== poolOfTeam.get(d) && poolOfTeam.get(c) !== poolOfTeam.get(b)) {
        pairs[i] = [a, d];
        pairs[j] = [c, b];
        break;
      }
    }
  }

  avoidRound2PoolClashes(byes, pairs, poolOfTeam);

  return { byes, pairs };
}

/**
 * `generateKnockoutRound` advances byes (first) then round-1 winners (in `pairs` order) and pairs
 * that advancing list two-by-two for round 2 — so e.g. `pairs[0]` and `pairs[1]` could meet in
 * round 2 regardless of who wins each (with one bye slotting into the first group when there's an
 * odd number of byes). This reorders `pairs` to break up any such round-2 group where both sides
 * could still share a pool. Reordering whole pairs (rather than individual teams) can't reintroduce
 * a round-1 clash, since each pair's own two teams always travel together, and byes' own relative
 * order never matters (see `buildKnockoutSeeds`). Best-effort, like the round-1 pass above: with
 * few enough pools feeding the bracket, some round-2 same-pool group can be mathematically
 * unavoidable (e.g. a single pool supplying most of the remaining, non-bye seeds).
 */
function avoidRound2PoolClashes(byes: string[], pairs: [string, string][], poolOfTeam: Map<string, string>): void {
  const segmentStart = byes.length;
  const totalSlots = segmentStart + pairs.length;
  const slotAt = (globalIndex: number): string[] =>
    globalIndex < segmentStart ? [byes[globalIndex]] : pairs[globalIndex - segmentStart];
  const poolsOf = (slot: string[]) => slot.map((id) => poolOfTeam.get(id));
  const clash = (x: string[], y: string[]) => poolsOf(x).some((p) => poolsOf(y).includes(p));
  const partnerOf = (globalIndex: number): number => (globalIndex % 2 === 0 ? globalIndex + 1 : globalIndex - 1);

  for (let k = 0; k < pairs.length; k++) {
    const globalIndex = segmentStart + k;
    const partnerIndex = partnerOf(globalIndex);
    if (partnerIndex >= totalSlots || !clash(pairs[k], slotAt(partnerIndex))) continue;

    for (let m = 0; m < pairs.length; m++) {
      if (m === k || segmentStart + m === partnerIndex) continue;
      [pairs[k], pairs[m]] = [pairs[m], pairs[k]];
      const mPartnerIndex = partnerOf(segmentStart + m);
      const kFixed = !clash(pairs[k], slotAt(partnerIndex));
      const mStillOk = mPartnerIndex >= totalSlots || !clash(pairs[m], slotAt(mPartnerIndex));
      if (kFixed && mStillOk) break;
      [pairs[k], pairs[m]] = [pairs[m], pairs[k]]; // revert
    }
  }
}

function stableRandomWinner(team1Id: string, team2Id: string): string {
  return stableRandomKey(team1Id) <= stableRandomKey(team2Id) ? team1Id : team2Id;
}

/**
 * Decides the winner of a completed knockout match — unlike swiss/pool matches, a knockout match
 * can never end in a draw. TD comparison decides it outright; on a TD tie, walks the tournament's
 * configured tiebreakers, using only the ones with single-match meaning: `net_cas`/`net_agg` on
 * this match's own stats, and `head_to_head` over the full match history in `challenges` (this can
 * still be informative even though the CURRENT match is drawn by definition here — e.g. the two
 * teams may have met earlier in the pool phase). `fewest_td_conceded`, `most_td_scored` and
 * `net_td` are skipped (always equal/zero on a TD-tied match by definition) and `opponent_score`
 * is skipped (a whole-tournament strength-of-schedule stat, meaningless for one match). `random`,
 * or running out of configured criteria without a decision, falls back to a deterministic coin
 * flip so a winner is always produced.
 */
export function getKnockoutWinner(
  result: MatchResult,
  team1Id: string,
  team2Id: string,
  tiebreakers: TiebreakerCriterion[],
  challenges: Challenge[] = []
): string {
  if (result.team1Td !== result.team2Td) {
    return result.team1Td > result.team2Td ? team1Id : team2Id;
  }
  for (const criterion of tiebreakers) {
    if (criterion === 'net_cas') {
      const diff = result.team1Cas - result.team2Cas;
      if (diff !== 0) return diff > 0 ? team1Id : team2Id;
    } else if (criterion === 'net_agg') {
      const diff = result.team1Agg - result.team2Agg;
      if (diff !== 0) return diff > 0 ? team1Id : team2Id;
    } else if (criterion === 'head_to_head') {
      const winner = headToHeadWinner(challenges, team1Id, team2Id);
      if (winner) return winner;
    } else if (criterion === 'random') {
      return stableRandomWinner(team1Id, team2Id);
    }
  }
  return stableRandomWinner(team1Id, team2Id);
}
