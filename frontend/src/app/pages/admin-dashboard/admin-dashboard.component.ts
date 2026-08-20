import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  type AdminTournamentView,
  type PublicTournament,
  type SquadScoringConfig,
  type SubmitResultRequest,
} from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { rosterStatusLabel } from '../../core/roster-status';
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

  readonly rosterStatusLabel = rosterStatusLabel;

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
      if (!silent) {
        this.descriptionDraft = this.tournament.description;
        if (this.tournament.squadScoring) this.squadScoringDraft = { ...this.tournament.squadScoring };
      }
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

  freeChallenges(): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === null) ?? [];
  }

  teamRosterImageUrl(teamId: string): string | null {
    const team = this.tournament?.teams.find((t) => t.id === teamId);
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }

  lightboxImageUrl: string | null = null;

  openImageLightbox(url: string): void {
    this.lightboxImageUrl = url;
  }

  closeImageLightbox(): void {
    this.lightboxImageUrl = null;
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

  nafExportUrl(): string {
    return this.api.nafExportUrl(this.tournamentId, this.token);
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

  private mergePublicTournament(pub: PublicTournament): void {
    if (!this.tournament) return;
    const teams = this.tournament.teams.map((adminTeam) => {
      const updated = pub.teams.find((t) => t.id === adminTeam.id);
      return updated ? { ...adminTeam, ...updated } : adminTeam;
    });
    this.tournament = { ...this.tournament, teams, challenges: pub.challenges, standings: pub.standings };
  }

  async setRosterStatus(teamId: string, status: 'validated' | 'created'): Promise<void> {
    this.actionBusy = true;
    this.actionError = null;
    try {
      const pub = await this.api.updateRosterStatus(this.tournamentId, teamId, { token: this.token }, status);
      this.mergePublicTournament(pub);
    } catch (err) {
      this.actionError = extractErrorMessage(err);
    } finally {
      this.actionBusy = false;
    }
  }

  roundBusy = false;
  roundError: string | null = null;
  swapMatchId1 = '';
  swapMatchId2 = '';

  roundMatches(roundNumber: number): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === roundNumber) ?? [];
  }

  async generateRound(): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.generateRound(this.tournamentId, this.token);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async swapMatches(roundNumber: number): Promise<void> {
    if (!this.swapMatchId1 || !this.swapMatchId2) return;
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.swapRoundMatches(
        this.tournamentId,
        this.token,
        roundNumber,
        this.swapMatchId1,
        this.swapMatchId2
      );
      this.swapMatchId1 = '';
      this.swapMatchId2 = '';
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  async launchRound(roundNumber: number): Promise<void> {
    this.roundBusy = true;
    this.roundError = null;
    try {
      this.tournament = await this.api.launchRound(this.tournamentId, this.token, roundNumber);
    } catch (err) {
      this.roundError = extractErrorMessage(err);
    } finally {
      this.roundBusy = false;
    }
  }

  squadBusy = false;
  squadError: string | null = null;
  newSquadName = '';
  renamingSquadId: string | null = null;
  renameSquadDraft = '';
  squadScoringDraft: SquadScoringConfig | null = null;
  savingSquadScoring = false;

  squadMemberCount(squadId: string): number {
    return this.tournament?.teams.filter((t) => t.squadId === squadId).length ?? 0;
  }

  async createSquad(): Promise<void> {
    const name = this.newSquadName.trim();
    if (!name) return;
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.createSquad(this.tournamentId, this.token, name);
      this.newSquadName = '';
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  startRenameSquad(squadId: string, currentName: string): void {
    this.renamingSquadId = squadId;
    this.renameSquadDraft = currentName;
  }

  cancelRenameSquad(): void {
    this.renamingSquadId = null;
  }

  async saveRenameSquad(squadId: string): Promise<void> {
    const name = this.renameSquadDraft.trim();
    if (!name) return;
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.renameSquad(this.tournamentId, this.token, squadId, name);
      this.renamingSquadId = null;
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  async deleteSquad(squadId: string): Promise<void> {
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.deleteSquad(this.tournamentId, this.token, squadId);
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  async assignTeamSquad(teamId: string, squadId: string): Promise<void> {
    this.squadBusy = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.assignTeamSquad(this.tournamentId, this.token, teamId, squadId || null);
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.squadBusy = false;
    }
  }

  async saveSquadScoring(): Promise<void> {
    if (!this.squadScoringDraft) return;
    this.savingSquadScoring = true;
    this.squadError = null;
    try {
      this.tournament = await this.api.updateSquadScoring(this.tournamentId, this.token, this.squadScoringDraft);
      if (this.tournament.squadScoring) this.squadScoringDraft = { ...this.tournament.squadScoring };
    } catch (err) {
      this.squadError = extractErrorMessage(err);
    } finally {
      this.savingSquadScoring = false;
    }
  }
}
