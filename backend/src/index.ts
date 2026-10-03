import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/aws-lambda';
import { AppError } from './errors';
import * as tournaments from './handlers/tournaments';
import * as teams from './handlers/teams';
import * as challenges from './handlers/challenges';
import * as rounds from './handlers/rounds';
import * as squads from './handlers/squads';
import * as pools from './handlers/pools';
import * as naf from './handlers/naf';
import * as backups from './handlers/backups';
import * as rosterImage from './rosterImage';

const app = new Hono().basePath('/api');

app.use('*', cors());

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
  }
  console.error('Unhandled error', err);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

app.post('/tournaments', tournaments.createTournament);
app.get('/tournaments/:tournamentId', tournaments.getPublicTournament);
app.get('/tournaments/:tournamentId/admin', tournaments.getAdminTournament);
app.patch('/tournaments/:tournamentId/description', tournaments.updateDescription);
app.patch('/tournaments/:tournamentId/organizer', tournaments.updateOrganizer);
app.patch('/tournaments/:tournamentId/display-settings', tournaments.updateDisplaySettings);
app.patch('/tournaments/:tournamentId/result-validation-settings', tournaments.updateResultValidationSettings);
app.patch('/tournaments/:tournamentId/round-timer', tournaments.updateRoundTimer);
app.patch('/tournaments/:tournamentId/individual-scoring', tournaments.updateIndividualScoring);
app.patch('/tournaments/:tournamentId/match-sheet-config', tournaments.updateMatchSheetConfig);
app.put('/tournaments/:tournamentId/custom-stat-categories', tournaments.updateCustomStatCategories);
app.get('/tournaments/:tournamentId/naf-export', naf.exportNaf);

app.get('/tournaments/:tournamentId/backups', backups.listBackups);
app.post('/tournaments/:tournamentId/backups', backups.createBackup);

app.post('/tournaments/:tournamentId/teams', teams.createTeam);
app.post('/tournaments/:tournamentId/teams/import', teams.importTeams);
app.get('/tournaments/:tournamentId/teams/find', teams.findMyTeam);
app.get('/tournaments/:tournamentId/teams/:teamId/verify', teams.verifyTeamAccess);
app.patch('/tournaments/:tournamentId/teams/:teamId', teams.updateTeam);
app.delete('/tournaments/:tournamentId/teams/:teamId', teams.deleteTeam);
app.post('/tournaments/:tournamentId/teams/:teamId/roster-image/upload-url', rosterImage.getUploadUrl);
app.post('/tournaments/:tournamentId/teams/:teamId/roster-image/confirm', rosterImage.confirmUpload);
app.patch('/tournaments/:tournamentId/teams/:teamId/roster-status', teams.updateRosterStatus);

app.post('/tournaments/:tournamentId/squads', squads.createSquad);
app.patch('/tournaments/:tournamentId/squads/:squadId', squads.renameSquad);
app.delete('/tournaments/:tournamentId/squads/:squadId', squads.deleteSquad);
app.patch('/tournaments/:tournamentId/teams/:teamId/squad', squads.assignTeamSquad);
app.patch('/tournaments/:tournamentId/squad-scoring', squads.updateSquadScoring);

app.post('/tournaments/:tournamentId/pools/generate', pools.generatePools);
app.patch('/tournaments/:tournamentId/pools/:poolId', pools.renamePool);
app.patch('/tournaments/:tournamentId/teams/:teamId/pool', pools.assignTeamPool);

app.post('/tournaments/:tournamentId/challenges', challenges.createChallenge);
app.patch('/tournaments/:tournamentId/challenges/:challengeId', challenges.actionChallenge);
app.put('/tournaments/:tournamentId/challenges/:challengeId/result', challenges.submitResult);
app.post('/tournaments/:tournamentId/challenges/:challengeId/result/confirm', challenges.confirmResult);
app.put('/tournaments/:tournamentId/challenges/:challengeId/result/admin', challenges.adminSetResult);

app.post('/tournaments/:tournamentId/rounds', rounds.generateRound);
app.post('/tournaments/:tournamentId/rounds/:roundNumber/swap', rounds.swapMatches);
app.post('/tournaments/:tournamentId/rounds/:roundNumber/launch', rounds.launch);
app.post('/tournaments/:tournamentId/rounds/:roundNumber/cancel-launch', rounds.cancelLaunch);
app.post('/tournaments/:tournamentId/knockout/launch', rounds.launchKnockout);

export const handler = handle(app);
