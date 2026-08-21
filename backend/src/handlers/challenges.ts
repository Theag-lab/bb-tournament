import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  Challenge,
  ChallengeActionRequest,
  CreateChallengeRequest,
  DEFAULT_INDIVIDUAL_SCORING,
  SubmitResultRequest,
  Tournament,
  computeMatchScore,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { authenticateTeam, isAdmin } from '../auth';
import { toPublicTournament } from '../sanitize';
import { badRequest, forbidden, notFound, unauthorized } from '../errors';

const ACTIVE_STATUSES = new Set(['pending', 'accepted', 'awaiting_confirmation']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Free (non-round) challenges: always on for ladder, only pre-round-1 for swiss_with_challenge. */
function canCreateFreeChallenge(t: Tournament): boolean {
  if (t.mode === 'ladder') return true;
  if (t.mode === 'swiss_with_challenge') return t.rounds.length === 0;
  return false;
}

function hasActiveFreeChallenge(t: Tournament, teamId: string): boolean {
  return t.challenges.some(
    (ch) => ch.round === null && ACTIVE_STATUSES.has(ch.status) && (ch.team1Id === teamId || ch.team2Id === teamId)
  );
}

/** Round-based matches can't be played until the admin has launched that round. */
function assertRoundIsLaunched(t: Tournament, challenge: Challenge): void {
  if (challenge.round === null) return;
  const round = t.rounds.find((r) => r.number === challenge.round);
  if (!round || round.status !== 'launched') {
    throw forbidden('This round has not been launched yet', 'round_not_launched');
  }
}

export async function createChallenge(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.query('teamId');
  const password = c.req.query('password');
  const body = await c.req.json<CreateChallengeRequest>().catch(() => null);
  const opponentTeamId = body?.opponentTeamId;
  if (!opponentTeamId) throw badRequest('opponentTeamId is required');

  await storage.updateTournament(tournamentId, (t) => {
    const challenger = authenticateTeam(t, teamId, password);
    if (!canCreateFreeChallenge(t)) {
      throw forbidden('Free challenges are not available in this tournament right now', 'free_challenge_unavailable');
    }
    if (t.requireRosterValidation && challenger.rosterStatus !== 'validated') {
      throw forbidden('Your roster must be validated before you can challenge another team', 'roster_not_validated');
    }
    if (challenger.id === opponentTeamId) throw badRequest('A team cannot challenge itself');
    const opponent = t.teams.find((tm) => tm.id === opponentTeamId);
    if (!opponent) throw notFound('Opponent team not found');

    if (t.mode === 'swiss_with_challenge') {
      if (hasActiveFreeChallenge(t, challenger.id)) {
        throw forbidden('You already have an active challenge; resolve it before creating another', 'challenge_limit_reached');
      }
      if (hasActiveFreeChallenge(t, opponent.id)) {
        throw forbidden('This team already has an active challenge with someone else', 'opponent_unavailable');
      }
    }

    const alreadyActive = t.challenges.some(
      (ch) =>
        ACTIVE_STATUSES.has(ch.status) &&
        ((ch.team1Id === challenger.id && ch.team2Id === opponent.id) ||
          (ch.team1Id === opponent.id && ch.team2Id === challenger.id))
    );
    if (alreadyActive) throw forbidden('There is already an active challenge between these two teams', 'challenge_already_active');

    const now = new Date().toISOString();
    const challenge: Challenge = {
      id: uuidv4(),
      team1Id: challenger.id,
      team2Id: opponent.id,
      status: 'pending',
      round: null,
      createdAt: now,
      updatedAt: now,
      result: null,
    };
    t.challenges.push(challenge);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, teamId ?? null), 201);
}

export async function actionChallenge(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const challengeId = c.req.param('challengeId')!;
  const teamId = c.req.query('teamId');
  const password = c.req.query('password');
  const token = c.req.query('token');
  const body = await c.req.json<ChallengeActionRequest>().catch(() => null);
  const action = body?.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
    throw badRequest('action must be one of: accept, decline, cancel');
  }

  let admin = false;
  await storage.updateTournament(tournamentId, (t) => {
    const challenge = t.challenges.find((ch) => ch.id === challengeId);
    if (!challenge) throw notFound('Challenge not found');
    if (challenge.status !== 'pending') throw forbidden(`Challenge is not pending (status: ${challenge.status})`);

    admin = isAdmin(t, token);
    const team = admin ? null : authenticateTeam(t, teamId, password);

    if (action === 'accept' || action === 'decline') {
      if (!admin && team!.id !== challenge.team2Id) throw forbidden('Only the challenged team can respond to this challenge');
      challenge.status = action === 'accept' ? 'accepted' : 'declined';
    } else {
      if (!admin && team!.id !== challenge.team1Id) throw forbidden('Only the challenger can cancel this challenge');
      challenge.status = 'cancelled';
    }
    challenge.updatedAt = new Date().toISOString();
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, admin ? null : teamId ?? null));
}

function validateResultInput(body: Partial<SubmitResultRequest> | null): SubmitResultRequest {
  if (!body) throw badRequest('Result payload is required');
  const { team1Td, team2Td, team1Cas, team2Cas, team1Agg, team2Agg, concededByTeamId = null, playedAt } = body;
  if (concededByTeamId === null) {
    for (const [field, value] of [
      ['team1Td', team1Td],
      ['team2Td', team2Td],
      ['team1Cas', team1Cas],
      ['team2Cas', team2Cas],
    ] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw badRequest(`${field} must be a non-negative number`);
      }
    }
    // Aggressions are a secondary/bonus stat (used only for the AggroLord award), so unlike
    // TD/Cas they're optional and default to 0 rather than being required on every submission.
    for (const [field, value] of [
      ['team1Agg', team1Agg],
      ['team2Agg', team2Agg],
    ] as const) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw badRequest(`${field} must be a non-negative number`);
      }
    }
  }
  if (playedAt !== undefined && (typeof playedAt !== 'string' || !DATE_PATTERN.test(playedAt))) {
    throw badRequest('playedAt must be a date in YYYY-MM-DD format');
  }
  return {
    playedAt: playedAt ?? todayIsoDate(),
    team1Td: team1Td ?? 0,
    team2Td: team2Td ?? 0,
    team1Cas: team1Cas ?? 0,
    team2Cas: team2Cas ?? 0,
    team1Agg: team1Agg ?? 0,
    team2Agg: team2Agg ?? 0,
    concededByTeamId,
  };
}

function sameResultValues(a: SubmitResultRequest, b: SubmitResultRequest): boolean {
  return (
    a.playedAt === b.playedAt &&
    a.team1Td === b.team1Td &&
    a.team2Td === b.team2Td &&
    a.team1Cas === b.team1Cas &&
    a.team2Cas === b.team2Cas &&
    a.team1Agg === b.team1Agg &&
    a.team2Agg === b.team2Agg &&
    a.concededByTeamId === b.concededByTeamId
  );
}

export async function submitResult(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const challengeId = c.req.param('challengeId')!;
  const teamId = c.req.query('teamId');
  const password = c.req.query('password');
  const body = await c.req.json<SubmitResultRequest>().catch(() => null);
  const input = validateResultInput(body);

  await storage.updateTournament(tournamentId, (t) => {
    const challenge = t.challenges.find((ch) => ch.id === challengeId);
    if (!challenge) throw notFound('Challenge not found');
    if (challenge.status !== 'accepted' && challenge.status !== 'awaiting_confirmation') {
      throw forbidden(`Cannot submit a result for a challenge with status: ${challenge.status}`);
    }
    assertRoundIsLaunched(t, challenge);

    const team = authenticateTeam(t, teamId, password);
    if (team.id !== challenge.team1Id && team.id !== challenge.team2Id) {
      throw forbidden('Only the two participating teams can submit a result');
    }
    if (input.concededByTeamId && input.concededByTeamId !== challenge.team1Id && input.concededByTeamId !== challenge.team2Id) {
      throw badRequest('concededByTeamId must be one of the two teams in this match');
    }

    const score = computeMatchScore(
      input,
      challenge.team1Id,
      challenge.team2Id,
      t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING
    );
    const now = new Date().toISOString();

    if (challenge.status === 'awaiting_confirmation' && challenge.result) {
      const previousSubmitter = challenge.result.submittedByTeamId;
      if (team.id === previousSubmitter) {
        // Same team editing their own pending submission.
        challenge.result = {
          ...score,
          playedAt: input.playedAt,
          concededByTeamId: input.concededByTeamId,
          submittedByTeamId: team.id,
          submittedAt: now,
          confirmedByTeamId: null,
          completedAt: null,
        };
        challenge.updatedAt = now;
        return;
      }

      const previousInput: SubmitResultRequest = {
        playedAt: challenge.result.playedAt,
        team1Td: challenge.result.team1Td,
        team2Td: challenge.result.team2Td,
        team1Cas: challenge.result.team1Cas,
        team2Cas: challenge.result.team2Cas,
        team1Agg: challenge.result.team1Agg,
        team2Agg: challenge.result.team2Agg,
        concededByTeamId: challenge.result.concededByTeamId,
      };
      if (sameResultValues(previousInput, input)) {
        // The other team submitted matching numbers: auto-confirm.
        challenge.result.confirmedByTeamId = team.id;
        challenge.result.completedAt = now;
        challenge.status = 'completed';
        challenge.updatedAt = now;
        return;
      }

      // Disagreement: this becomes the new pending submission awaiting the other side.
      challenge.result = {
        ...score,
        playedAt: input.playedAt,
        concededByTeamId: input.concededByTeamId,
        submittedByTeamId: team.id,
        submittedAt: now,
        confirmedByTeamId: null,
        completedAt: null,
      };
      challenge.updatedAt = now;
      return;
    }

    // First submission for this challenge.
    challenge.result = {
      ...score,
      playedAt: input.playedAt,
      concededByTeamId: input.concededByTeamId,
      submittedByTeamId: team.id,
      submittedAt: now,
      confirmedByTeamId: null,
      completedAt: null,
    };
    challenge.status = 'awaiting_confirmation';
    challenge.updatedAt = now;
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, teamId ?? null));
}

export async function confirmResult(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const challengeId = c.req.param('challengeId')!;
  const teamId = c.req.query('teamId');
  const password = c.req.query('password');

  await storage.updateTournament(tournamentId, (t) => {
    const challenge = t.challenges.find((ch) => ch.id === challengeId);
    if (!challenge) throw notFound('Challenge not found');
    if (challenge.status !== 'awaiting_confirmation' || !challenge.result) {
      throw forbidden(`No pending result to confirm (status: ${challenge.status})`);
    }
    assertRoundIsLaunched(t, challenge);

    const team = authenticateTeam(t, teamId, password);
    if (team.id !== challenge.team1Id && team.id !== challenge.team2Id) {
      throw forbidden('Only the two participating teams can confirm a result');
    }
    if (team.id === challenge.result.submittedByTeamId) {
      throw forbidden('The submitting team cannot confirm their own result; the other team must confirm');
    }

    const now = new Date().toISOString();
    challenge.result.confirmedByTeamId = team.id;
    challenge.result.completedAt = now;
    challenge.status = 'completed';
    challenge.updatedAt = now;
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, teamId ?? null));
}

export async function adminSetResult(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const challengeId = c.req.param('challengeId')!;
  const token = c.req.query('token');
  const body = await c.req.json<SubmitResultRequest>().catch(() => null);
  const input = validateResultInput(body);

  await storage.updateTournament(tournamentId, (t) => {
    if (!isAdmin(t, token)) throw unauthorized('Admin token required');
    const challenge = t.challenges.find((ch) => ch.id === challengeId);
    if (!challenge) throw notFound('Challenge not found');
    if (input.concededByTeamId && input.concededByTeamId !== challenge.team1Id && input.concededByTeamId !== challenge.team2Id) {
      throw badRequest('concededByTeamId must be one of the two teams in this match');
    }
    if (challenge.status === 'pending') challenge.status = 'accepted';

    const score = computeMatchScore(
      input,
      challenge.team1Id,
      challenge.team2Id,
      t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING
    );
    const now = new Date().toISOString();
    challenge.result = {
      ...score,
      playedAt: input.playedAt,
      concededByTeamId: input.concededByTeamId,
      submittedByTeamId: challenge.team1Id,
      submittedAt: now,
      confirmedByTeamId: challenge.team2Id,
      completedAt: now,
      finalizedByAdmin: true,
    };
    challenge.status = 'completed';
    challenge.updatedAt = now;
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament));
}
