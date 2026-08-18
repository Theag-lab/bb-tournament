import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AdminTournamentView,
  ChallengeAction,
  CreateChallengeRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  CreateTournamentResponse,
  PublicTournament,
  ResolveTeamResponse,
  RosterImageUploadUrlRequest,
  RosterImageUploadUrlResponse,
  SubmitResultRequest,
} from '@bb-tournament/shared';

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

  createTournament(name: string) {
    return firstValueFrom(this.http.post<CreateTournamentResponse>(`${API_BASE}/tournaments`, { name }));
  }

  getTournament(tournamentId: string) {
    return firstValueFrom(this.http.get<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}`));
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

  createTeam(tournamentId: string, body: CreateTeamRequest) {
    return firstValueFrom(
      this.http.post<CreateTeamResponse>(`${API_BASE}/tournaments/${tournamentId}/teams`, body)
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
}
