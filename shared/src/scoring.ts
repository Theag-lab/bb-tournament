import {
  Challenge,
  CustomStatCategoryConfig,
  CustomStatLeaderboard,
  CustomStatLeaderboardEntry,
  CustomStatValue,
  IndividualScoringConfig,
  MatchResult,
  RawPointsComponent,
  RosterTier,
  Squad,
  SquadScoringConfig,
  SquadStandingEntry,
  SquadTiebreakerCriterion,
  StandingEntry,
  SubmitResultRequest,
  Team,
  TiebreakerCriterion,
  customTiebreakerCategoryId,
  isCustomTiebreakerCriterion,
  resolveRosterTiers,
  resolveSquadScoring,
  rosterTierOf,
  squadOutcomeKey,
} from './types';

export const CONCESSION_SCORE = 3;

/**
 * Reproduces the historical fixed scoring exactly (5/2/0 points, -5 concession penalty, and the
 * tiebreaker order that used to be hardcoded into computeStandings' sort comparator), so
 * tournaments created before this config existed keep behaving identically until an admin
 * deliberately changes it.
 */
export const DEFAULT_INDIVIDUAL_SCORING: IndividualScoringConfig = {
  mode: 'points_tiebreaker',
  pointsWin: 5,
  pointsDraw: 2,
  pointsLoss: 0,
  pointsConcessionPenalty: -5,
  tiebreakers: ['fewest_td_conceded', 'opponent_score', 'net_td', 'random', 'net_cas'],
  td: { basis: 'diff', multiplier: 0 },
  cas: { basis: 'diff', multiplier: 0 },
  agg: { basis: 'diff', multiplier: 0 },
};

export interface ComputedScore {
  team1Td: number;
  team2Td: number;
  team1Cas: number;
  team2Cas: number;
  team1Agg: number;
  team2Agg: number;
  customStats: Record<string, CustomStatValue>;
  team1Points: number;
  team2Points: number;
}

/** One side's contribution from a raw-points component (0 if the component is disabled via multiplier 0). */
function rawPointsComponentValue(component: RawPointsComponent, forValue: number, againstValue: number): number {
  const base = component.basis === 'diff' ? forValue - againstValue : forValue;
  return base * component.multiplier;
}

/**
 * The win/draw/loss points for one side, given its classic outcome (always decided by TD
 * comparison, regardless of scoring mode) and whether it's the side that conceded.
 */
function outcomePoints(
  config: IndividualScoringConfig,
  outcome: 'win' | 'draw' | 'loss',
  conceded: boolean
): number {
  if (conceded) return config.pointsConcessionPenalty;
  if (outcome === 'win') return config.pointsWin;
  if (outcome === 'draw') return config.pointsDraw;
  return config.pointsLoss;
}

/** Points for both sides of a match, given its final (post-concession-forced) stats. */
function computePointsFromStats(
  config: IndividualScoringConfig,
  team1Td: number,
  team2Td: number,
  team1Cas: number,
  team2Cas: number,
  team1Agg: number,
  team2Agg: number,
  customStats: Record<string, CustomStatValue>,
  customStatCategories: CustomStatCategoryConfig[],
  team1Conceded: boolean,
  team2Conceded: boolean
): { team1Points: number; team2Points: number } {
  const outcome1: 'win' | 'draw' | 'loss' = team1Td > team2Td ? 'win' : team2Td > team1Td ? 'loss' : 'draw';
  const outcome2: 'win' | 'draw' | 'loss' = outcome1 === 'win' ? 'loss' : outcome1 === 'loss' ? 'win' : 'draw';

  let team1Points = outcomePoints(config, outcome1, team1Conceded);
  let team2Points = outcomePoints(config, outcome2, team2Conceded);

  if (config.mode === 'raw_points') {
    team1Points +=
      rawPointsComponentValue(config.td, team1Td, team2Td) +
      rawPointsComponentValue(config.cas, team1Cas, team2Cas) +
      rawPointsComponentValue(config.agg, team1Agg, team2Agg);
    team2Points +=
      rawPointsComponentValue(config.td, team2Td, team1Td) +
      rawPointsComponentValue(config.cas, team2Cas, team1Cas) +
      rawPointsComponentValue(config.agg, team2Agg, team1Agg);

    for (const category of customStatCategories) {
      const value = customStats[category.id];
      if (!value) continue;
      team1Points += rawPointsComponentValue(category.rawPoints, value.team1, value.team2);
      team2Points += rawPointsComponentValue(category.rawPoints, value.team2, value.team1);
    }
  }

  return { team1Points, team2Points };
}

/**
 * Applies NAF-style concession handling (forced 3-0 in the winner's favor)
 * and computes tournament points from the final score, per the tournament's IndividualScoringConfig.
 * `customStatCategories` is the tournament's *current* category list — only categories still
 * `enabled` there get their submitted value recorded (an id absent from the current list, e.g. one
 * deleted since, is simply dropped); a concession records no custom stats at all (0-0 for every
 * category), same spirit as forcing a fixed 3-0 for TD/Cas/Agg but with no made-up NAF number to
 * force for a category we know nothing about.
 */
export function computeMatchScore(
  input: SubmitResultRequest,
  team1Id: string,
  team2Id: string,
  config: IndividualScoringConfig,
  customStatCategories: CustomStatCategoryConfig[] = []
): ComputedScore {
  let team1Td: number, team2Td: number, team1Cas: number, team2Cas: number, team1Agg: number, team2Agg: number;
  let team1Conceded = false;
  let team2Conceded = false;
  const customStats: Record<string, CustomStatValue> = {};

  if (input.concededByTeamId) {
    if (input.concededByTeamId !== team1Id && input.concededByTeamId !== team2Id) {
      throw new Error('concededByTeamId must be one of the two teams in the match');
    }
    team1Conceded = input.concededByTeamId === team1Id;
    team2Conceded = !team1Conceded;
    team1Td = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Td = team1Conceded ? CONCESSION_SCORE : 0;
    team1Cas = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Cas = team1Conceded ? CONCESSION_SCORE : 0;
    team1Agg = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Agg = team1Conceded ? CONCESSION_SCORE : 0;
    for (const category of customStatCategories) {
      if (category.enabled) customStats[category.id] = { team1: 0, team2: 0 };
    }
  } else {
    team1Td = Math.max(0, Math.trunc(input.team1Td));
    team2Td = Math.max(0, Math.trunc(input.team2Td));
    team1Cas = Math.max(0, Math.trunc(input.team1Cas));
    team2Cas = Math.max(0, Math.trunc(input.team2Cas));
    team1Agg = Math.max(0, Math.trunc(input.team1Agg));
    team2Agg = Math.max(0, Math.trunc(input.team2Agg));
    for (const category of customStatCategories) {
      if (!category.enabled) continue;
      const raw = input.customStats?.[category.id];
      customStats[category.id] = {
        team1: Math.max(0, Math.trunc(raw?.team1 ?? 0)),
        team2: Math.max(0, Math.trunc(raw?.team2 ?? 0)),
      };
    }
  }

  const { team1Points, team2Points } = computePointsFromStats(
    config,
    team1Td,
    team2Td,
    team1Cas,
    team2Cas,
    team1Agg,
    team2Agg,
    customStats,
    customStatCategories,
    team1Conceded,
    team2Conceded
  );

  return { team1Td, team2Td, team1Cas, team2Cas, team1Agg, team2Agg, customStats, team1Points, team2Points };
}

/**
 * Recomputes a completed match's team1Points/team2Points from its already-recorded raw stats,
 * per a (possibly newly-changed) IndividualScoringConfig and/or CustomStatCategoryConfig list —
 * used when the admin edits the tournament's scoring config, so already-played matches immediately
 * reflect the new rules instead of staying frozen at whatever config was active when they were
 * submitted.
 */
export function recomputeMatchPoints(
  result: MatchResult,
  team1Id: string,
  team2Id: string,
  config: IndividualScoringConfig,
  customStatCategories: CustomStatCategoryConfig[] = []
): { team1Points: number; team2Points: number } {
  const team1Conceded = result.concededByTeamId === team1Id;
  const team2Conceded = result.concededByTeamId === team2Id;
  return computePointsFromStats(
    config,
    result.team1Td,
    result.team2Td,
    result.team1Cas,
    result.team2Cas,
    result.team1Agg,
    result.team2Agg,
    result.customStats ?? {},
    customStatCategories,
    team1Conceded,
    team2Conceded
  );
}

/**
 * A stable, deterministic stand-in for a physical "random draw" tiebreak: the same pair of teams
 * always resolves the same way (so standings don't reshuffle on every poll), while carrying no
 * relationship to anything meaningful about the team — an arbitrary but fixed coin-flip result.
 */
export function stableRandomKey(teamId: string): number {
  let hash = 0;
  for (let i = 0; i < teamId.length; i++) {
    hash = (hash * 31 + teamId.charCodeAt(i)) | 0;
  }
  return hash;
}

/** One comparator per selectable built-in TiebreakerCriterion except 'head_to_head' (needs the
 * match list rather than just the two aggregate StandingEntry), 'roster_tier' (needs the teams'
 * races and the tournament's tiers) and `custom:${id}` (needs the category id) — all handled
 * separately in computeStandings.
 * More info wins (returns < 0 means `a` ranks first). */
const TIEBREAKER_COMPARATORS: Record<
  Exclude<TiebreakerCriterion, 'head_to_head' | 'roster_tier' | `custom:${string}`>,
  (a: StandingEntry, b: StandingEntry) => number
> = {
  fewest_td_conceded: (a, b) => a.tdAgainst - b.tdAgainst,
  most_td_scored: (a, b) => b.tdFor - a.tdFor,
  opponent_score: (a, b) => b.opponentScore - a.opponentScore,
  net_td: (a, b) => b.tdFor - b.tdAgainst - (a.tdFor - a.tdAgainst),
  net_cas: (a, b) => b.casFor - b.casAgainst - (a.casFor - a.casAgainst),
  net_agg: (a, b) => b.aggFor - b.aggAgainst - (a.aggFor - a.aggAgainst),
  most_cas_caused: (a, b) => b.casFor - a.casFor,
  random: (a, b) => stableRandomKey(a.teamId) - stableRandomKey(b.teamId),
};

/** Net-diff comparator for a `custom:${categoryId}` tiebreaker — same convention as net_td/net_cas/net_agg. */
function compareCustomStat(categoryId: string, a: StandingEntry, b: StandingEntry): number {
  const statA = a.customStats[categoryId];
  const statB = b.customStats[categoryId];
  const netA = (statA?.for ?? 0) - (statA?.against ?? 0);
  const netB = (statB?.for ?? 0) - (statB?.against ?? 0);
  return netB - netA;
}

/**
 * Resolves head-to-head dominance between exactly two teams from their completed meetings only:
 * the team with strictly more wins over the other (by classic TD comparison, independent of the
 * scoring mode) wins it. Returns null when they never met, or split their meetings evenly
 * (including the degenerate "met once and drew" case) — there's no signal to act on either way, so
 * this tiebreaker criterion falls through to the next one.
 */
export function headToHeadWinner(challenges: Challenge[], teamAId: string, teamBId: string): string | null {
  let aWins = 0;
  let bWins = 0;
  for (const c of challenges) {
    if (c.status !== 'completed' || !c.result) continue;
    const involvesA = c.team1Id === teamAId || c.team2Id === teamAId;
    const involvesB = c.team1Id === teamBId || c.team2Id === teamBId;
    if (!involvesA || !involvesB) continue;
    const r = c.result;
    if (r.team1Td === r.team2Td) continue; // drew this meeting, no signal from it
    const winnerId = r.team1Td > r.team2Td ? c.team1Id : c.team2Id;
    if (winnerId === teamAId) aWins++;
    else if (winnerId === teamBId) bWins++;
  }
  if (aWins === bWins) return null;
  return aWins > bWins ? teamAId : teamBId;
}

function compareHeadToHead(challenges: Challenge[], a: StandingEntry, b: StandingEntry): number {
  const winner = headToHeadWinner(challenges, a.teamId, b.teamId);
  if (winner === a.teamId) return -1;
  if (winner === b.teamId) return 1;
  return 0;
}

/**
 * Standings ordering: total points first, per `config`. In 'points_tiebreaker' mode, ties are then
 * broken by `config.tiebreakers` in order; in 'raw_points' mode there are no configured
 * tiebreakers (the score itself already encodes TD/CAS/Agg), so this only falls through to the
 * final stable-random tiebreak added for full determinism.
 */
export function computeStandings(
  teams: Team[],
  challenges: Challenge[],
  config: IndividualScoringConfig,
  customStatCategories: CustomStatCategoryConfig[] = [],
  rosterTiers: RosterTier[] | null = null
): StandingEntry[] {
  const tiers = resolveRosterTiers(rosterTiers);
  const tierOfTeam = new Map(teams.map((t) => [t.id, rosterTierOf(t.race, tiers)]));
  const byTeam = new Map<string, StandingEntry>();
  for (const team of teams) {
    byTeam.set(team.id, {
      teamId: team.id,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      tdFor: 0,
      tdAgainst: 0,
      casFor: 0,
      casAgainst: 0,
      aggFor: 0,
      aggAgainst: 0,
      gamesPlayed: 0,
      opponentScore: 0,
      customStats: {},
    });
  }

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    const s1 = byTeam.get(challenge.team1Id);
    const s2 = byTeam.get(challenge.team2Id);
    if (!s1 || !s2) continue;

    s1.points += r.team1Points;
    s2.points += r.team2Points;
    s1.tdFor += r.team1Td;
    s1.tdAgainst += r.team2Td;
    s2.tdFor += r.team2Td;
    s2.tdAgainst += r.team1Td;
    s1.casFor += r.team1Cas;
    s1.casAgainst += r.team2Cas;
    s2.casFor += r.team2Cas;
    s2.casAgainst += r.team1Cas;
    s1.aggFor += r.team1Agg;
    s1.aggAgainst += r.team2Agg;
    s2.aggFor += r.team2Agg;
    s2.aggAgainst += r.team1Agg;
    s1.gamesPlayed += 1;
    s2.gamesPlayed += 1;

    for (const category of customStatCategories) {
      const value = r.customStats?.[category.id];
      if (!value) continue;
      const e1 = (s1.customStats[category.id] ??= { for: 0, against: 0 });
      const e2 = (s2.customStats[category.id] ??= { for: 0, against: 0 });
      e1.for += value.team1;
      e1.against += value.team2;
      e2.for += value.team2;
      e2.against += value.team1;
    }

    // W/D/L is always the classic TD-based outcome, independent of the scoring mode/config — a
    // team's record shouldn't change just because the admin tweaks how many points a win is worth.
    if (r.team1Td > r.team2Td) {
      s1.wins += 1;
      s2.losses += 1;
    } else if (r.team2Td > r.team1Td) {
      s2.wins += 1;
      s1.losses += 1;
    } else {
      s1.draws += 1;
      s2.draws += 1;
    }
  }

  // Opponent score (Buchholz) needs every team's FINAL points, so it's a second pass over the
  // now-fully-accumulated standings rather than something foldable into the loop above.
  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const s1 = byTeam.get(challenge.team1Id);
    const s2 = byTeam.get(challenge.team2Id);
    if (!s1 || !s2) continue;
    s1.opponentScore += s2.points;
    s2.opponentScore += s1.points;
  }

  const criteria = config.mode === 'points_tiebreaker' ? config.tiebreakers : [];
  return Array.from(byTeam.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const criterion of criteria) {
      const cmp = isCustomTiebreakerCriterion(criterion)
        ? compareCustomStat(customTiebreakerCategoryId(criterion)!, a, b)
        : criterion === 'head_to_head'
          ? compareHeadToHead(challenges, a, b)
          : criterion === 'roster_tier'
            ? (tierOfTeam.get(b.teamId) ?? 0) - (tierOfTeam.get(a.teamId) ?? 0)
            : TIEBREAKER_COMPARATORS[criterion](a, b);
      if (cmp !== 0) return cmp;
    }
    // Final deterministic fallback so equal totals never leave the order ambiguous, even if
    // 'random' wasn't explicitly configured (or raw_points mode, which has no tiebreaker list).
    return TIEBREAKER_COMPARATORS.random(a, b);
  });
}

/**
 * One standalone leaderboard per enabled custom stat category, ranked by each team's total "for"
 * value (most first, not net diff — this is a plain "who racked up the most X" table, same spirit
 * as a NAF major's "Most casualties" award, independent of the main points standings). Teams with
 * no completed matches (or no recorded value for that category) are omitted rather than shown as a
 * 0-way tie for last.
 */
export function computeCustomStatLeaderboards(
  teams: Team[],
  challenges: Challenge[],
  customStatCategories: CustomStatCategoryConfig[]
): CustomStatLeaderboard[] {
  const enabled = customStatCategories.filter((c) => c.enabled);
  if (enabled.length === 0) return [];

  const totals = new Map<string, Map<string, number>>(); // categoryId -> teamId -> total
  for (const category of enabled) totals.set(category.id, new Map());

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    for (const category of enabled) {
      const value = r.customStats?.[category.id];
      if (!value) continue;
      const byTeam = totals.get(category.id)!;
      byTeam.set(challenge.team1Id, (byTeam.get(challenge.team1Id) ?? 0) + value.team1);
      byTeam.set(challenge.team2Id, (byTeam.get(challenge.team2Id) ?? 0) + value.team2);
    }
  }

  const teamIds = new Set(teams.map((t) => t.id));
  return enabled.map((category) => {
    const byTeam = totals.get(category.id)!;
    const standings: CustomStatLeaderboardEntry[] = Array.from(byTeam.entries())
      .filter(([teamId]) => teamIds.has(teamId))
      .map(([teamId, total]) => ({ teamId, total }))
      .sort((a, b) => b.total - a.total || stableRandomKey(a.teamId) - stableRandomKey(b.teamId));
    return { categoryId: category.id, name: category.name, standings };
  });
}

/**
 * Squad points for one side's board record in a round (W-D-L from that side's point of view):
 * win/draw/loss by boards won vs lost, upgraded to "grande victoire" or "petite défaite" when
 * bonus tiers are on and that exact record is listed — see SquadScoringConfig.
 */
export function squadPointsForOutcome(wins: number, draws: number, losses: number, cfg: SquadScoringConfig): number {
  const key = squadOutcomeKey(wins, draws, losses);
  if (wins > losses) return cfg.bonusTiers && cfg.bigWinOutcomes.includes(key) ? cfg.pointsBigWin : cfg.pointsWin;
  if (wins < losses) return cfg.bonusTiers && cfg.smallLossOutcomes.includes(key) ? cfg.pointsSmallLoss : cfg.pointsLoss;
  return cfg.pointsDraw;
}

/**
 * Squad-level standings for 'team' format tournaments: aggregates every completed match played
 * by each squad's member teams. Squad score comes from `squadPointsForOutcome`, not the
 * individual W/D/L points used by `computeStandings` — the two are independent scoring systems.
 *
 * W/D/L and squad points are per ROUND, not per individual match: each round a squad plays exactly
 * one opposing squad (its members' matches are the "boards" of that one round-matchup, like a
 * chess team match). A round's result is decided by the squad's BOARD record — boards won / drawn /
 * lost that round, each board by plain TD comparison — not by the TD-difference of any single
 * match; `squadPointsForOutcome` turns that record into points.
 */
export function computeSquadStandings(
  squads: Squad[],
  teams: Team[],
  challenges: Challenge[],
  rawScoring: Partial<SquadScoringConfig>,
  individualScoring: IndividualScoringConfig = DEFAULT_INDIVIDUAL_SCORING,
  customStatCategories: CustomStatCategoryConfig[] = [],
  rosterTiers: RosterTier[] | null = null
): SquadStandingEntry[] {
  const scoring = resolveSquadScoring(rawScoring);
  const squadOfTeam = new Map(teams.map((t) => [t.id, t.squadId]));
  // Sum of the members' roster tiers, for the `roster_tier` squad tiebreaker.
  const tiers = resolveRosterTiers(rosterTiers);
  const tierSumOfSquad = new Map<string, number>();
  for (const team of teams) {
    if (!team.squadId) continue;
    tierSumOfSquad.set(team.squadId, (tierSumOfSquad.get(team.squadId) ?? 0) + rosterTierOf(team.race, tiers));
  }
  const byId = new Map<string, SquadStandingEntry>();
  for (const squad of squads) {
    byId.set(squad.id, {
      squadId: squad.id,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      tdFor: 0,
      tdAgainst: 0,
      casFor: 0,
      casAgainst: 0,
      aggFor: 0,
      aggAgainst: 0,
      gamesPlayed: 0,
      memberPoints: 0,
      opponentScore: 0,
      individualLosses: 0,
    });
  }

  for (const standing of computeStandings(teams, challenges, individualScoring, customStatCategories, rosterTiers)) {
    const squadId = squadOfTeam.get(standing.teamId);
    const entry = squadId ? byId.get(squadId) : undefined;
    if (entry) entry.memberPoints += standing.points;
  }

  // Per-round squad-vs-squad pair board tallies (head-to-head only), keyed so both member pairings
  // of the same round land in the same bucket regardless of which squad is team1/team2.
  interface RoundMatchup {
    squadA: string;
    squadB: string;
    boardWinsA: number;
    boardLossesA: number;
  }
  const roundMatchups = new Map<string, RoundMatchup>();

  // One squad's whole board record for one round, whoever the boards were against: with an odd
  // number of squads, three of them play a "triangle" (half their boards against each of the two
  // others) and their round result is the record over all their boards, scored like any other.
  // Free challenges (no round) keep one record per opponent squad.
  interface RoundRecord {
    squadId: string;
    wins: number;
    draws: number;
    losses: number;
    opponents: Set<string>;
  }
  const roundRecords = new Map<string, RoundRecord>();
  const recordBoard = (round: number | null, squadId: string, opponentSquadId: string, outcome: number) => {
    const key = round === null ? `null:${squadId}:${opponentSquadId}` : `${round}:${squadId}`;
    let record = roundRecords.get(key);
    if (!record) {
      record = { squadId, wins: 0, draws: 0, losses: 0, opponents: new Set() };
      roundRecords.set(key, record);
    }
    record.opponents.add(opponentSquadId);
    if (outcome > 0) record.wins += 1;
    else if (outcome < 0) record.losses += 1;
    else record.draws += 1;
  };

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    const squad1Id = squadOfTeam.get(challenge.team1Id);
    const squad2Id = squadOfTeam.get(challenge.team2Id);
    if (!squad1Id || !squad2Id) continue;
    const e1 = byId.get(squad1Id);
    const e2 = byId.get(squad2Id);
    if (!e1 || !e2) continue;

    e1.tdFor += r.team1Td;
    e1.tdAgainst += r.team2Td;
    e2.tdFor += r.team2Td;
    e2.tdAgainst += r.team1Td;
    e1.casFor += r.team1Cas;
    e1.casAgainst += r.team2Cas;
    e2.casFor += r.team2Cas;
    e2.casAgainst += r.team1Cas;
    e1.aggFor += r.team1Agg;
    e1.aggAgainst += r.team2Agg;
    e2.aggFor += r.team2Agg;
    e2.aggAgainst += r.team1Agg;
    e1.gamesPlayed += 1;
    e2.gamesPlayed += 1;
    if (r.team1Td < r.team2Td) e1.individualLosses += 1;
    else if (r.team2Td < r.team1Td) e2.individualLosses += 1;

    if (squad1Id === squad2Id) continue; // shouldn't happen, but guard against self-matchup skew
    const [squadA, squadB] = squad1Id < squad2Id ? [squad1Id, squad2Id] : [squad2Id, squad1Id];
    const key = `${challenge.round}:${squadA}:${squadB}`;
    let matchup = roundMatchups.get(key);
    if (!matchup) {
      matchup = { squadA, squadB, boardWinsA: 0, boardLossesA: 0 };
      roundMatchups.set(key, matchup);
    }
    // Board result is always the plain TD comparison — independent of any scoring config.
    const boardOutcomeForSquad1 = r.team1Td > r.team2Td ? 1 : r.team1Td < r.team2Td ? -1 : 0;
    const boardOutcomeForA = squad1Id === squadA ? boardOutcomeForSquad1 : -boardOutcomeForSquad1;
    if (boardOutcomeForA > 0) matchup.boardWinsA += 1;
    else if (boardOutcomeForA < 0) matchup.boardLossesA += 1;
    recordBoard(challenge.round, squad1Id, squad2Id, boardOutcomeForSquad1);
    recordBoard(challenge.round, squad2Id, squad1Id, -boardOutcomeForSquad1);
  }

  // Head-to-head: round wins of squadA minus round wins of squadB, over every round they met (in a
  // triangle, only the boards the two squads played against each other).
  const headToHeadNetA = new Map<string, number>();
  for (const { squadA, squadB, boardWinsA, boardLossesA } of roundMatchups.values()) {
    const pairKey = `${squadA}:${squadB}`;
    headToHeadNetA.set(pairKey, (headToHeadNetA.get(pairKey) ?? 0) + Math.sign(boardWinsA - boardLossesA));
  }

  for (const { squadId, wins, draws, losses } of roundRecords.values()) {
    const entry = byId.get(squadId)!;
    entry.points += squadPointsForOutcome(wins, draws, losses, scoring);
    if (wins > losses) entry.wins += 1;
    else if (wins < losses) entry.losses += 1;
    else entry.draws += 1;
  }

  // Strength of schedule, from final squad points: needs every round tallied first. A triangle
  // round counts the average of its two opponents, so it weighs like any other round.
  for (const { squadId, opponents } of roundRecords.values()) {
    const entry = byId.get(squadId)!;
    let sum = 0;
    for (const opponentId of opponents) sum += byId.get(opponentId)?.points ?? 0;
    entry.opponentScore += sum / opponents.size;
  }

  const criteria = scoring.tiebreakers;
  return Array.from(byId.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const criterion of criteria) {
      const cmp =
        criterion === 'head_to_head'
          ? compareSquadHeadToHead(headToHeadNetA, a, b)
          : criterion === 'roster_tier'
            ? (tierSumOfSquad.get(b.squadId) ?? 0) - (tierSumOfSquad.get(a.squadId) ?? 0)
            : SQUAD_TIEBREAKER_COMPARATORS[criterion](a, b);
      if (cmp !== 0) return cmp;
    }
    // Final deterministic fallback so equal squads never leave the order ambiguous.
    return SQUAD_TIEBREAKER_COMPARATORS.random(a, b);
  });
}

/**
 * Squad head-to-head: the squad that won more of the rounds the two played against each other ranks
 * first (a round's winner is decided by board differential, as for squad points). Never met, or
 * split evenly -> 0, falling through to the next criterion.
 */
function compareSquadHeadToHead(headToHeadNetA: Map<string, number>, a: SquadStandingEntry, b: SquadStandingEntry): number {
  const aIsSquadA = a.squadId < b.squadId;
  const key = aIsSquadA ? `${a.squadId}:${b.squadId}` : `${b.squadId}:${a.squadId}`;
  const netForA = (headToHeadNetA.get(key) ?? 0) * (aIsSquadA ? 1 : -1);
  return -Math.sign(netForA);
}

/** Squad equivalent of TIEBREAKER_COMPARATORS — more info wins (returns < 0 means `a` ranks first). */
const SQUAD_TIEBREAKER_COMPARATORS: Record<
  Exclude<SquadTiebreakerCriterion, 'head_to_head' | 'roster_tier'>,
  (a: SquadStandingEntry, b: SquadStandingEntry) => number
> = {
  member_points: (a, b) => b.memberPoints - a.memberPoints,
  opponent_score: (a, b) => b.opponentScore - a.opponentScore,
  fewest_individual_losses: (a, b) => a.individualLosses - b.individualLosses,
  net_td: (a, b) => b.tdFor - b.tdAgainst - (a.tdFor - a.tdAgainst),
  net_cas: (a, b) => b.casFor - b.casAgainst - (a.casFor - a.casAgainst),
  net_agg: (a, b) => b.aggFor - b.aggAgainst - (a.aggFor - a.aggAgainst),
  most_td_scored: (a, b) => b.tdFor - a.tdFor,
  fewest_td_conceded: (a, b) => a.tdAgainst - b.tdAgainst,
  most_cas_caused: (a, b) => b.casFor - a.casFor,
  random: (a, b) => stableRandomKey(a.squadId) - stableRandomKey(b.squadId),
};

/**
 * Each squad's opposing squads among one round's matches. A squad with two opponents plays that
 * round's triangle (odd number of squads); the third squad of a confrontation's triangle is the
 * one both of its squads face besides each other.
 */
export function roundSquadOpponents(
  matches: { team1Id: string; team2Id: string }[],
  squadOf: (teamId: string) => string | null
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const m of matches) {
    const [x, y] = [squadOf(m.team1Id), squadOf(m.team2Id)];
    if (!x || !y || x === y) continue;
    if (!map.has(x)) map.set(x, new Set());
    if (!map.has(y)) map.set(y, new Set());
    map.get(x)!.add(y);
    map.get(y)!.add(x);
  }
  return map;
}

/** The third squad of the triangle `squadA` and `squadB` play in, or null for a plain confrontation. */
export function triangleThirdSquad(opponents: Map<string, Set<string>>, squadA: string, squadB: string): string | null {
  for (const id of opponents.get(squadA) ?? []) if (id !== squadB) return id;
  for (const id of opponents.get(squadB) ?? []) if (id !== squadA) return id;
  return null;
}
