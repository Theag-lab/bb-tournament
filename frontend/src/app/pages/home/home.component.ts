import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MAX_ROUND_COUNT, MIN_ROUND_COUNT, type TournamentMode } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { adminUrl, copyToClipboard } from '../../core/links';

type WizardStep = 'name' | 'mode' | 'rounds' | 'validation' | 'review';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly minRoundCount = MIN_ROUND_COUNT;
  readonly maxRoundCount = MAX_ROUND_COUNT;

  name = '';
  mode: TournamentMode = 'ladder';
  roundCount = 3;
  requireRosterValidation = false;

  busy = false;
  error: string | null = null;
  createdAdminLink: string | null = null;
  createdTournamentId: string | null = null;

  joinTournamentId = '';
  copied = false;

  stepIndex = 0;

  get steps(): WizardStep[] {
    const steps: WizardStep[] = ['name', 'mode'];
    if (this.mode !== 'ladder') steps.push('rounds');
    steps.push('validation', 'review');
    return steps;
  }

  get currentStep(): WizardStep {
    const steps = this.steps;
    return steps[Math.min(this.stepIndex, steps.length - 1)];
  }

  get stepNumber(): number {
    return Math.min(this.stepIndex, this.steps.length - 1) + 1;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  modeLabel(mode: TournamentMode): string {
    switch (mode) {
      case 'ladder':
        return 'Défi libre (ladder)';
      case 'swiss':
        return 'Rondes suisses';
      case 'swiss_with_challenge':
        return 'Rondes suisses avec défis en 1ère ronde';
    }
  }

  canGoNext(): boolean {
    switch (this.currentStep) {
      case 'name':
        return this.name.trim().length > 0;
      case 'rounds':
        return this.roundCount >= this.minRoundCount && this.roundCount <= this.maxRoundCount;
      default:
        return true;
    }
  }

  next(): void {
    if (!this.canGoNext()) return;
    this.stepIndex = Math.min(this.stepIndex + 1, this.steps.length - 1);
  }

  back(): void {
    this.stepIndex = Math.max(this.stepIndex - 1, 0);
  }

  async create(): Promise<void> {
    const name = this.name.trim();
    if (!name) return;
    this.busy = true;
    this.error = null;
    try {
      const res = await this.api.createTournament({
        name,
        requireRosterValidation: this.requireRosterValidation,
        mode: this.mode,
        roundCount: this.mode === 'ladder' ? undefined : this.roundCount,
      });
      this.createdTournamentId = res.tournamentId;
      this.createdAdminLink = adminUrl(res.tournamentId, res.adminToken);
    } catch (err) {
      this.error = extractErrorMessage(err);
    } finally {
      this.busy = false;
    }
  }

  goToScoreboard(): void {
    if (this.createdTournamentId) {
      this.router.navigate(['/tournaments', this.createdTournamentId]);
    }
  }

  joinExisting(): void {
    const raw = this.joinTournamentId.trim();
    if (!raw) return;
    const match = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const id = match ? match[0] : raw;
    this.router.navigate(['/tournaments', id]);
  }

  async copyAdminLink(): Promise<void> {
    if (!this.createdAdminLink) return;
    this.copied = await copyToClipboard(this.createdAdminLink);
  }
}
