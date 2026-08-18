import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  RACES,
  ROSTER_IMAGE_ALLOWED_CONTENT_TYPES,
  ROSTER_IMAGE_MAX_SIZE_BYTES,
  type PublicTeam,
  type PublicTournament,
  type SubmitResultRequest,
} from '@bb-tournament/shared';
import { ApiService, type Auth } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { rosterImageUrl } from '../../core/links';
import { uploadToS3 } from '../../core/upload';
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
  password = '';

  tournament: PublicTournament | null = null;
  loading = true;
  loadError: string | null = null;

  actionError: string | null = null;
  actionBusy = false;

  editName = '';
  editCoachName = '';
  editRace = '';
  editPassword = '';
  savingProfile = false;

  challengeOpponentId = '';

  editingResultChallengeId: string | null = null;

  rosterUploadBusy = false;
  rosterUploadError: string | null = null;

  private get auth(): Auth {
    return { teamId: this.teamId, password: this.password };
  }

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    this.teamId = this.route.snapshot.paramMap.get('teamId')!;
    this.password = this.route.snapshot.paramMap.get('password')!;

    try {
      await this.api.verifyTeamAccess(this.tournamentId, this.teamId, this.password);
    } catch (err) {
      this.loadError = extractErrorMessage(err);
      this.loading = false;
      return;
    }

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
        this.editPassword = this.password;
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

  myRosterImageUrl(): string | null {
    const team = this.myTeam;
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }

  async saveProfile(): Promise<void> {
    const name = this.editName.trim();
    const coachName = this.editCoachName.trim();
    const race = this.editRace.trim();
    const password = this.editPassword.trim();
    if (!name || !coachName || !race || !password) return;
    this.savingProfile = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.updateTeam(this.tournamentId, this.teamId, this.auth, {
        name,
        coachName,
        race,
        password,
      });
      this.password = password;
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
      this.tournament = await this.api.createChallenge(this.tournamentId, this.auth, {
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
      this.tournament = await this.api.actionChallenge(this.tournamentId, challengeId, this.auth, action);
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
      this.tournament = await this.api.submitResult(this.tournamentId, challengeId, this.auth, body);
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
      this.tournament = await this.api.confirmResult(this.tournamentId, challengeId, this.auth);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  async onRosterFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.rosterUploadError = null;
    if (!(ROSTER_IMAGE_ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      this.rosterUploadError = 'Formats acceptés : JPEG, PNG, WebP.';
      return;
    }
    if (file.size > ROSTER_IMAGE_MAX_SIZE_BYTES) {
      this.rosterUploadError = `Image trop lourde (max ${Math.round(ROSTER_IMAGE_MAX_SIZE_BYTES / 1024 / 1024)} Mo).`;
      return;
    }

    this.rosterUploadBusy = true;
    try {
      const { url, fields } = await this.api.getRosterImageUploadUrl(
        this.tournamentId,
        this.teamId,
        this.auth,
        file.type
      );
      await uploadToS3(url, fields, file);
      this.tournament = await this.api.confirmRosterImageUpload(this.tournamentId, this.teamId, this.auth);
    } catch (err) {
      this.rosterUploadError = extractErrorMessage(err);
    } finally {
      this.rosterUploadBusy = false;
    }
  }
}
