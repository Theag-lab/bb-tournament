import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RACES, type PublicTeam, type PublicTournament, type SubmitResultRequest } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { MatchResultFormComponent } from '../../shared/match-result-form/match-result-form.component';

const POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-team-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, MatchResultFormComponent],
  templateUrl: './team-dashboard.component.html',
  styleUrl: './team-dashboard.component.scss',
})
export class TeamDashboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly races = RACES;

  tournamentId = '';
  teamId = '';
  token = '';

  tournament: PublicTournament | null = null;
  loading = true;
  loadError: string | null = null;

  actionError: string | null = null;
  actionBusy = false;

  editName = '';
  editCoachName = '';
  editRace = '';
  savingProfile = false;

  challengeOpponentId = '';

  editingResultChallengeId: string | null = null;

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    this.teamId = this.route.snapshot.paramMap.get('teamId')!;
    this.token = this.route.snapshot.paramMap.get('token')!;
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.tournament = await this.api.getTournament(this.tournamentId);
      this.loadError = null;
      const myTeam = this.myTeam;
      if (myTeam && !silent) {
        this.editName = myTeam.name;
        this.editCoachName = myTeam.coachName;
        this.editRace = myTeam.race;
      }
    } catch (err) {
      this.loadError = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  get myTeam(): PublicTeam | null {
    return this.tournament?.teams.find((t) => t.id === this.teamId) ?? null;
  }

  get otherTeams(): PublicTeam[] {
    return this.tournament?.teams.filter((t) => t.id !== this.teamId) ?? [];
  }

  get myChallenges(): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.team1Id === this.teamId || c.team2Id === this.teamId) ?? [];
  }

  teamName(teamId: string): string {
    return this.tournament?.teams.find((t) => t.id === teamId)?.name ?? '—';
  }

  opponentId(c: PublicTournament['challenges'][number]): string {
    return c.team1Id === this.teamId ? c.team2Id : c.team1Id;
  }

  isChallenger(c: PublicTournament['challenges'][number]): boolean {
    return c.team1Id === this.teamId;
  }

  iSubmittedLast(c: PublicTournament['challenges'][number]): boolean {
    return c.result?.submittedByTeamId === this.teamId;
  }

  async saveProfile(): Promise<void> {
    const name = this.editName.trim();
    const coachName = this.editCoachName.trim();
    const race = this.editRace.trim();
    if (!name || !coachName || !race) return;
    this.savingProfile = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.updateTeam(this.tournamentId, this.teamId, this.token, {
        name,
        coachName,
        race,
      });
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.savingProfile = false;
    }
  }

  async sendChallenge(): Promise<void> {
    if (!this.challengeOpponentId) return;
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.createChallenge(this.tournamentId, this.token, {
        opponentTeamId: this.challengeOpponentId,
      });
      this.challengeOpponentId = '';
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  async respond(challengeId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.actionChallenge(this.tournamentId, challengeId, this.token, action);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  toggleResultForm(challengeId: string): void {
    this.editingResultChallengeId = this.editingResultChallengeId === challengeId ? null : challengeId;
  }

  async submitResult(challengeId: string, body: SubmitResultRequest): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.submitResult(this.tournamentId, challengeId, this.token, body);
      this.editingResultChallengeId = null;
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  async confirmResult(challengeId: string): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.confirmResult(this.tournamentId, challengeId, this.token);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }
}
