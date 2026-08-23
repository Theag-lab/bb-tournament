import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AdminTournamentView,
  AssignTeamPoolRequest,
  AssignTeamSquadRequest,
  ChallengeAction,
  CreateChallengeRequest,
  CreateSquadRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  CreateTournamentRequest,
  CreateTournamentResponse,
  ImportTeamRow,
  ImportTeamsResponse,
  PublicTournament,
  ResolveTeamResponse,
  RosterImageUploadUrlRequest,
  RosterImageUploadUrlResponse,
  RosterStatus,
  SubmitResultRequest,
  UpdateIndividualScoringRequest,
  UpdateRoundTimerRequest,
  UpdateSquadRequest,
  UpdateSquadScoringRequest,
} from '@bb-tournament/shared';

/** Identifies "myself" when loading a tournament, so I still see my own team even if others are masked. */
export interface Viewer {
  teamId: string;
  password: string;
}

const API_BASE = '/api';

/** A team's own id + password, or the tournament admin token — never both are required at once. */
export interface Auth {
  teamId?: string;
  password?: string;
  token?: string;
}

function authParams(auth: Auth): Record<string, string> {
  const params: Record<string, string> = {};
  if (auth.teamId) params['teamId'] = auth.teamId;
  if (auth.password) params['password'] = auth.password;
  if (auth.token) params['token'] = auth.token;
  return params;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  createTournament(body: CreateTournamentRequest) {
    return firstValueFrom(this.http.post<CreateTournamentResponse>(`${API_BASE}/tournaments`, body));
  }

  getTournament(tournamentId: string, viewer?: Viewer) {
    const params: Record<string, string> = {};
    if (viewer) {
      params['viewerTeamId'] = viewer.teamId;
      params['viewerPassword'] = viewer.password;
    }
    return firstValueFrom(this.http.get<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}`, { params }));
  }

  getAdminTournament(tournamentId: string, token: string) {
    return firstValueFrom(
      this.http.get<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/admin`, { params: { token } })
    );
  }

  updateDescription(tournamentId: string, token: string, description: string) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/description`,
        { description },
        { params: { token } }
      )
    );
  }

  updateOrganizer(tournamentId: string, token: string, organizerCoachName: string) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/organizer`,
        { organizerCoachName },
        { params: { token } }
      )
    );
  }

  updateDisplaySettings(tournamentId: string, token: string, showTeamNames: boolean) {
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(
        `${API_BASE}/tournaments/${tournamentId}/display-settings`,
        { showTeamNames },
        { params: { token } }
      )
    );
  }

  updateRoundTimer(tournamentId: string, token: string, body: UpdateRoundTimerRequest) {
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/round-timer`, body, {
        params: { token },
      })
    );
  }

  createTeam(tournamentId: string, body: CreateTeamRequest) {
    return firstValueFrom(
      this.http.post<CreateTeamResponse>(`${API_BASE}/tournaments/${tournamentId}/teams`, body)
    );
  }

  importTeams(tournamentId: string, token: string, rows: ImportTeamRow[]) {
    return firstValueFrom(
      this.http.post<ImportTeamsResponse>(
        `${API_BASE}/tournaments/${tournamentId}/teams/import`,
        { rows },
        { params: { token } }
      )
    );
  }

  /** "Find my team": look up by coach name + password when the participant has no saved link. */
  findMyTeam(tournamentId: string, coachName: string, password: string) {
    return firstValueFrom(
      this.http.get<ResolveTeamResponse>(`${API_BASE}/tournaments/${tournamentId}/teams/find`, {
        params: { coachName, password },
      })
    );
  }

  /** Confirms a teamId + password pair from a saved/bookmarked management link. */
  verifyTeamAccess(tournamentId: string, teamId: string, password: string) {
    return firstValueFrom(
      this.http.get<ResolveTeamResponse>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/verify`, {
        params: { password },
      })
    );
  }

  updateTeam(tournamentId: string, teamId: string, auth: Auth, body: Partial<CreateTeamRequest>) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}`, body, {
        params: authParams(auth),
      })
    );
  }

  deleteTeam(tournamentId: string, teamId: string, token: string) {
    return firstValueFrom(
      this.http.delete<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}`, {
        params: { token },
      })
    );
  }

  createChallenge(tournamentId: string, auth: Auth, body: CreateChallengeRequest) {
    return firstValueFrom(
      this.http.post<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}/challenges`, body, {
        params: authParams(auth),
      })
    );
  }

  actionChallenge(tournamentId: string, challengeId: string, auth: Auth, action: ChallengeAction) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}`,
        { action },
        { params: authParams(auth) }
      )
    );
  }

  submitResult(tournamentId: string, challengeId: string, auth: Auth, body: SubmitResultRequest) {
    return firstValueFrom(
      this.http.put<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}/result`,
        body,
        { params: authParams(auth) }
      )
    );
  }

  confirmResult(tournamentId: string, challengeId: string, auth: Auth) {
    return firstValueFrom(
      this.http.post<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}/result/confirm`,
        {},
        { params: authParams(auth) }
      )
    );
  }

  adminSetResult(tournamentId: string, challengeId: string, token: string, body: SubmitResultRequest) {
    return firstValueFrom(
      this.http.put<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}/result/admin`,
        body,
        { params: { token } }
      )
    );
  }

  getRosterImageUploadUrl(tournamentId: string, teamId: string, auth: Auth, contentType: string) {
    const body: RosterImageUploadUrlRequest = { contentType };
    return firstValueFrom(
      this.http.post<RosterImageUploadUrlResponse>(
        `${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/roster-image/upload-url`,
        body,
        { params: authParams(auth) }
      )
    );
  }

  confirmRosterImageUpload(tournamentId: string, teamId: string, auth: Auth) {
    return firstValueFrom(
      this.http.post<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/roster-image/confirm`,
        {},
        { params: authParams(auth) }
      )
    );
  }

  updateRosterStatus(tournamentId: string, teamId: string, auth: Auth, status: RosterStatus) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/roster-status`,
        { status },
        { params: authParams(auth) }
      )
    );
  }

  generateRound(tournamentId: string, token: string) {
    return firstValueFrom(
      this.http.post<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/rounds`, {}, { params: { token } })
    );
  }

  swapRoundMatches(tournamentId: string, token: string, roundNumber: number, matchId1: string, matchId2: string) {
    return firstValueFrom(
      this.http.post<AdminTournamentView>(
        `${API_BASE}/tournaments/${tournamentId}/rounds/${roundNumber}/swap`,
        { matchId1, matchId2 },
        { params: { token } }
      )
    );
  }

  /** Direct download link (GET, admin token in the query string) rather than a fetch — it's a file, not JSON. */
  nafExportUrl(tournamentId: string, token: string): string {
    return `${API_BASE}/tournaments/${tournamentId}/naf-export?token=${encodeURIComponent(token)}`;
  }

  launchRound(tournamentId: string, token: string, roundNumber: number) {
    return firstValueFrom(
      this.http.post<AdminTournamentView>(
        `${API_BASE}/tournaments/${tournamentId}/rounds/${roundNumber}/launch`,
        {},
        { params: { token } }
      )
    );
  }

  createSquad(tournamentId: string, token: string, name: string) {
    const body: CreateSquadRequest = { name };
    return firstValueFrom(
      this.http.post<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/squads`, body, { params: { token } })
    );
  }

  renameSquad(tournamentId: string, token: string, squadId: string, name: string) {
    const body: UpdateSquadRequest = { name };
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/squads/${squadId}`, body, {
        params: { token },
      })
    );
  }

  deleteSquad(tournamentId: string, token: string, squadId: string) {
    return firstValueFrom(
      this.http.delete<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/squads/${squadId}`, {
        params: { token },
      })
    );
  }

  assignTeamSquad(tournamentId: string, token: string, teamId: string, squadId: string | null) {
    const body: AssignTeamSquadRequest = { squadId };
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/squad`, body, {
        params: { token },
      })
    );
  }

  updateSquadScoring(tournamentId: string, token: string, body: UpdateSquadScoringRequest) {
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/squad-scoring`, body, {
        params: { token },
      })
    );
  }

  updateIndividualScoring(tournamentId: string, token: string, body: UpdateIndividualScoringRequest) {
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/individual-scoring`, body, {
        params: { token },
      })
    );
  }

  generatePools(tournamentId: string, token: string) {
    return firstValueFrom(
      this.http.post<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/pools/generate`, {}, { params: { token } })
    );
  }

  assignTeamPool(tournamentId: string, token: string, teamId: string, poolId: string | null) {
    const body: AssignTeamPoolRequest = { poolId };
    return firstValueFrom(
      this.http.patch<AdminTournamentView>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}/pool`, body, {
        params: { token },
      })
    );
  }

  launchKnockoutPhase(tournamentId: string, token: string) {
    return firstValueFrom(
      this.http.post<AdminTournamentView>(
        `${API_BASE}/tournaments/${tournamentId}/knockout/launch`,
        {},
        { params: { token } }
      )
    );
  }
}
