import {
  DEFAULT_INDIVIDUAL_SCORING,
  computeMatchScore,
  type Challenge,
  type MatchResult,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';

/**
 * FUMBBL result tracking, run by the cron Lambda (fumbblCron.ts) every 5 minutes from 18h to midnight, 15 otherwise:
 * 1. a game live on FUMBBL where at least one of the two teams carries the tournament's tag (some
 *    coaches forget to rename theirs), between the coaches of a scheduled (accepted, launched-round)
 *    match, gets linked to that match — its spectate link then shows on the scoreboard;
 * 2. once that game has left FUMBBL's live list, its finished match record is looked up (its
 *    replayId is the live game id) and the result is entered on the tournament.
 * Everything here except the fetch helpers is pure, so it's unit-tested without the network.
 */

export interface FumbblLiveTeam {
  id: number;
  name: string;
  coach: string;
}

/** One entry of https://fumbbl.com/api/match/current */
export interface FumbblLiveGame {
  id: number;
  teams: FumbblLiveTeam[];
}

export interface FumbblMatchTeam {
  id: number;
  name: string;
  score: number;
  casualties: { bh: number; si: number; rip: number };
  coach: { name: string };
}

/** https://fumbbl.com/api/match/get/<id> (also the shape of team/matches entries). */
export interface FumbblMatch {
  id: number;
  replayId: number;
  date: string;
  team1: FumbblMatchTeam;
  team2: FumbblMatchTeam;
}

/** A tracked game still unresolved this long after it was spotted (e.g. abandoned) is dropped. */
export const STALE_LINK_MS = 24 * 60 * 60 * 1000;

const normalize = (value: string) => value.trim().toLowerCase();

export function hasTag(teamName: string, tag: string): boolean {
  return normalize(teamName).includes(normalize(tag));
}

/** Tournament teams by normalised coach name; a name shared by two teams is ambiguous and left out. */
function teamsByCoachName(teams: Team[]): Map<string, Team> {
  const byName = new Map<string, Team | null>();
  for (const team of teams) {
    const key = normalize(team.coachName);
    byName.set(key, byName.has(key) ? null : team);
  }
  return new Map([...byName].filter((entry): entry is [string, Team] => entry[1] !== null));
}

function isTrackingEnabled(t: Tournament): boolean {
  return !!t.fumbbl?.enabled && !!t.fumbbl.tag.trim();
}

/**
 * Links each newly seen live game with at least one tagged team to the scheduled match between
 * its two coaches (status 'accepted', round launched or free challenge, not already linked).
 * Mutates `t`; returns the ids of the challenges it linked.
 */
export function linkLiveGames(t: Tournament, games: FumbblLiveGame[], now: string): string[] {
  if (!isTrackingEnabled(t)) return [];
  const tag = t.fumbbl!.tag;
  const byCoach = teamsByCoachName(t.teams);
  const launchedRounds = new Set(t.rounds.filter((r) => r.status === 'launched').map((r) => r.number));
  const trackedGameIds = new Set(t.challenges.flatMap((c) => (c.fumbbl ? [c.fumbbl.liveGameId] : [])));
  const linked: string[] = [];

  for (const game of games) {
    if (trackedGameIds.has(game.id) || game.teams.length !== 2) continue;
    const [home, away] = game.teams;
    if (!hasTag(home.name, tag) && !hasTag(away.name, tag)) continue;
    const homeTeam = byCoach.get(normalize(home.coach));
    const awayTeam = byCoach.get(normalize(away.coach));
    if (!homeTeam || !awayTeam || homeTeam.id === awayTeam.id) continue;

    const challenge = t.challenges.find(
      (c) =>
        c.status === 'accepted' &&
        !c.fumbbl &&
        (c.round === null || launchedRounds.has(c.round)) &&
        ((c.team1Id === homeTeam.id && c.team2Id === awayTeam.id) || (c.team1Id === awayTeam.id && c.team2Id === homeTeam.id))
    );
    if (!challenge) continue;

    const homeIsTeam1 = challenge.team1Id === homeTeam.id;
    challenge.fumbbl = {
      liveGameId: game.id,
      team1FumbblTeamId: homeIsTeam1 ? home.id : away.id,
      team2FumbblTeamId: homeIsTeam1 ? away.id : home.id,
      state: 'live',
      matchId: null,
      detectedAt: now,
      finishedAt: null,
    };
    linked.push(challenge.id);
  }
  return linked;
}

/** Tracked games that are no longer live on FUMBBL — i.e. finished (or abandoned). */
export function gamesNoLongerLive(t: Tournament, liveGameIds: Set<number>): Challenge[] {
  return t.challenges.filter((c) => c.fumbbl?.state === 'live' && !liveGameIds.has(c.fumbbl.liveGameId));
}

/** Unlinks tracked games never resolved within STALE_LINK_MS, so the match can be picked up again. Returns how many. */
export function dropStaleLinks(t: Tournament, liveGameIds: Set<number>, nowMs: number): number {
  let dropped = 0;
  for (const c of gamesNoLongerLive(t, liveGameIds)) {
    if (nowMs - Date.parse(c.fumbbl!.detectedAt) > STALE_LINK_MS) {
      delete c.fumbbl;
      dropped++;
    }
  }
  return dropped;
}

/** Sorties = every casualty a side inflicted (badly hurt + seriously injured + dead). */
function casualtiesOf(team: FumbblMatchTeam): number {
  return team.casualties.bh + team.casualties.si + team.casualties.rip;
}

/**
 * Records the finished FUMBBL match on its tracked challenge and, if no result was entered in the
 * meantime (status still 'accepted'), enters it as final. Agressions aren't reported by FUMBBL and
 * custom counters can't be, so both stay at 0. Returns the result entered, or null when the
 * challenge already had one (it's then left untouched, only the FUMBBL link is completed).
 */
export function applyFinishedMatch(t: Tournament, challenge: Challenge, match: FumbblMatch, now: string): MatchResult | null {
  const link = challenge.fumbbl;
  if (!link) return null;
  link.state = 'finished';
  link.matchId = match.id;
  link.finishedAt = now;
  if (challenge.status !== 'accepted') return null;

  const team1Side = match.team1.id === link.team1FumbblTeamId ? match.team1 : match.team2;
  const team2Side = team1Side === match.team1 ? match.team2 : match.team1;
  const input = {
    playedAt: match.date,
    team1Td: team1Side.score,
    team2Td: team2Side.score,
    team1Cas: casualtiesOf(team1Side),
    team2Cas: casualtiesOf(team2Side),
    team1Agg: 0,
    team2Agg: 0,
    customStats: {},
    concededByTeamId: null,
  };
  const score = computeMatchScore(
    input,
    challenge.team1Id,
    challenge.team2Id,
    t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
    t.customStatCategories ?? []
  );
  const result: MatchResult = {
    ...score,
    playedAt: input.playedAt,
    concededByTeamId: null,
    submittedByTeamId: challenge.team1Id,
    submittedAt: now,
    confirmedByTeamId: challenge.team2Id,
    completedAt: now,
    source: 'fumbbl',
  };
  challenge.result = result;
  challenge.status = 'completed';
  challenge.updatedAt = now;
  return result;
}

// ---- FUMBBL API ----

const FUMBBL_API = 'https://fumbbl.com/api';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${FUMBBL_API}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'bb-tournament.eu result tracker' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`FUMBBL ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export function fetchLiveGames(): Promise<FumbblLiveGame[]> {
  return getJson<FumbblLiveGame[]>('/match/current');
}

/**
 * The finished match of a tracked live game: FUMBBL's match id isn't the live game id, but the
 * match's replayId is — so it's found in one of the two teams' recent matches (newest first), then
 * read in full. Null while FUMBBL hasn't recorded it yet (retried on the next run).
 */
export async function fetchFinishedMatch(liveGameId: number, fumbblTeamId: number): Promise<FumbblMatch | null> {
  const recent = await getJson<{ id: number; replayId: number }[]>(`/team/matches/${fumbblTeamId}`);
  const summary = recent.find((m) => m.replayId === liveGameId);
  if (!summary) return null;
  return getJson<FumbblMatch>(`/match/get/${summary.id}`);
}
