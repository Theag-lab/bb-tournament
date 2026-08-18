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
  SubmitResultRequest,
} from '@bb-tournament/shared';

const API_BASE = '/api';

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

  createTeam(tournamentId: string, body: CreateTeamRequest) {
    return firstValueFrom(
      this.http.post<CreateTeamResponse>(`${API_BASE}/tournaments/${tournamentId}/teams`, body)
    );
  }

  updateTeam(tournamentId: string, teamId: string, token: string, body: Partial<CreateTeamRequest>) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}/teams/${teamId}`, body, {
        params: { token },
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

  createChallenge(tournamentId: string, token: string, body: CreateChallengeRequest) {
    return firstValueFrom(
      this.http.post<PublicTournament>(`${API_BASE}/tournaments/${tournamentId}/challenges`, body, {
        params: { token },
      })
    );
  }

  actionChallenge(tournamentId: string, challengeId: string, token: string, action: ChallengeAction) {
    return firstValueFrom(
      this.http.patch<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}`,
        { action },
        { params: { token } }
      )
    );
  }

  submitResult(tournamentId: string, challengeId: string, token: string, body: SubmitResultRequest) {
    return firstValueFrom(
      this.http.put<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}/result`,
        body,
        { params: { token } }
      )
    );
  }

  confirmResult(tournamentId: string, challengeId: string, token: string) {
    return firstValueFrom(
      this.http.post<PublicTournament>(
        `${API_BASE}/tournaments/${tournamentId}/challenges/${challengeId}/result/confirm`,
        {},
        { params: { token } }
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

  adminActionChallenge(tournamentId: string, challengeId: string, token: string, action: ChallengeAction) {
    return this.actionChallenge(tournamentId, challengeId, token, action);
  }
}
