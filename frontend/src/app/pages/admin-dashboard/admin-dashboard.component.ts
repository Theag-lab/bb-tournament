import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  type AdminTournamentView,
  type SubmitResultRequest,
} from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { MatchResultFormComponent } from '../../shared/match-result-form/match-result-form.component';

const POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, MatchResultFormComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.scss',
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  tournamentId = '';
  token = '';

  tournament: AdminTournamentView | null = null;
  loading = true;
  loadError: string | null = null;

  actionError: string | null = null;
  actionBusy = false;

  copiedTeamId: string | null = null;
  scoreboardCopied = false;

  editingResultChallengeId: string | null = null;

  readonly descriptionMaxLength = TOURNAMENT_DESCRIPTION_MAX_LENGTH;
  descriptionDraft = '';
  descriptionPreview = false;
  savingDescription = false;
  descriptionError: string | null = null;

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
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
      this.tournament = await this.api.getAdminTournament(this.tournamentId, this.token);
      if (!silent) this.descriptionDraft = this.tournament.description;
      this.loadError = null;
    } catch (err) {
      this.loadError = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  descriptionPreviewHtml(): string {
    return renderMarkdown(this.descriptionDraft);
  }

  async saveDescription(): Promise<void> {
    this.savingDescription = true;
    this.descriptionError = null;
    try {
      const pub = await this.api.updateDescription(this.tournamentId, this.token, this.descriptionDraft);
      this.tournament = { ...this.tournament!, description: pub.description };
    } catch (err) {
      this.descriptionError = extractErrorMessage(err);
    } finally {
      this.savingDescription = false;
    }
  }

  teamName(teamId: string): string {
    return this.tournament?.teams.find((t) => t.id === teamId)?.name ?? '—';
  }

  teamHasChallenges(teamId: string): boolean {
    return this.tournament?.challenges.some((c) => c.team1Id === teamId || c.team2Id === teamId) ?? false;
  }

  participantLink(teamId: string, password: string): string {
    return participantUrl(this.tournamentId, teamId, password);
  }

  async copyTeamLink(teamId: string, password: string): Promise<void> {
    const ok = await copyToClipboard(this.participantLink(teamId, password));
    this.copiedTeamId = ok ? teamId : null;
  }

  async copyScoreboardLink(): Promise<void> {
    this.scoreboardCopied = await copyToClipboard(scoreboardUrl(this.tournamentId));
  }

  async deleteTeam(teamId: string): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      this.tournament = await this.api.deleteTeam(this.tournamentId, teamId, this.token);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  async challengeAction(challengeId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.actionChallenge(this.tournamentId, challengeId, { token: this.token }, action);
      this.tournament = { ...this.tournament!, challenges: pub.challenges, standings: pub.standings };
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  toggleResultForm(challengeId: string): void {
    this.editingResultChallengeId = this.editingResultChallengeId === challengeId ? null : challengeId;
  }

  async forceResult(challengeId: string, body: SubmitResultRequest): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.adminSetResult(this.tournamentId, challengeId, this.token, body);
      this.tournament = { ...this.tournament!, challenges: pub.challenges, standings: pub.standings };
      this.editingResultChallengeId = null;
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }
}
