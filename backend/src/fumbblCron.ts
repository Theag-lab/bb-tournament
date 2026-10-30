import type { Challenge } from '@bb-tournament/shared';
import * as storage from './storage';
import {
  applyFinishedMatch,
  dropStaleLinks,
  fetchFinishedMatch,
  fetchLiveGames,
  gamesNoLongerLive,
  linkLiveGames,
  type FumbblMatch,
} from './fumbbl';
import { logMatchSheetEvent, toMatchResultLogView } from './matchSheetLog';

/**
 * Entry point of the FUMBBL cron Lambda (EventBridge Scheduler: every 5 minutes 18h-midnight Paris
 * time, every 15 otherwise — see the CDK stack). One call to FUMBBL's live-games list per run, shared by every subscribed tournament; finished games
 * cost two more calls each. Each tournament is processed independently so one failure (FUMBBL
 * hiccup, deleted tournament) doesn't block the others.
 */
export async function handler(): Promise<void> {
  const tournamentIds = await storage.getFumbblSubscriptions();
  if (tournamentIds.length === 0) return;

  const games = await fetchLiveGames();
  const liveGameIds = new Set(games.map((g) => g.id));
  for (const tournamentId of tournamentIds) {
    try {
      await processTournament(tournamentId, games, liveGameIds);
    } catch (e) {
      console.error(`FUMBBL tracking failed for tournament ${tournamentId}`, e);
    }
  }
}

async function processTournament(
  tournamentId: string,
  games: Awaited<ReturnType<typeof fetchLiveGames>>,
  liveGameIds: Set<number>
): Promise<void> {
  const snapshot = await storage.getTournament(tournamentId);
  if (!snapshot.fumbbl?.enabled) return;

  // Network lookups happen outside the write, so a concurrent-write retry doesn't refetch FUMBBL.
  const finishedMatches = new Map<string, FumbblMatch>();
  for (const challenge of gamesNoLongerLive(snapshot, liveGameIds)) {
    const link = challenge.fumbbl!;
    const match =
      (await fetchFinishedMatch(link.liveGameId, link.team1FumbblTeamId)) ??
      (await fetchFinishedMatch(link.liveGameId, link.team2FumbblTeamId));
    if (match) finishedMatches.set(challenge.id, match);
  }

  // Dry run on the snapshot: skip the write entirely on the (usual) runs where nothing changed.
  const now = new Date().toISOString();
  const nowMs = Date.now();
  if (linkLiveGames(snapshot, games, now).length === 0 && finishedMatches.size === 0 && dropStaleLinks(snapshot, liveGameIds, nowMs) === 0) {
    return;
  }

  const entered = await storage.updateTournament(tournamentId, (t) => {
    linkLiveGames(t, games, now);
    const results: Challenge[] = [];
    for (const [challengeId, match] of finishedMatches) {
      const challenge = t.challenges.find((c) => c.id === challengeId);
      if (challenge?.fumbbl?.state === 'live' && applyFinishedMatch(t, challenge, match, now)) results.push(challenge);
    }
    dropStaleLinks(t, liveGameIds, nowMs);
    return results.map((c) => c.id);
  });

  if (entered.length === 0) return;
  const tournament = await storage.getTournament(tournamentId);
  const coachName = (teamId: string) => tournament.teams.find((tm) => tm.id === teamId)?.coachName ?? teamId;
  for (const challengeId of entered) {
    const challenge = tournament.challenges.find((c) => c.id === challengeId);
    if (!challenge?.result) continue;
    await logMatchSheetEvent(
      tournamentId,
      tournament.name,
      coachName(challenge.team1Id),
      coachName(challenge.team2Id),
      `Saisie automatique FUMBBL (match ${challenge.fumbbl?.matchId})`,
      toMatchResultLogView(challenge.result, coachName)
    );
  }
}
