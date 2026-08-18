import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { adminUrl, copyToClipboard } from '../../core/links';

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

  name = '';
  busy = false;
  error: string | null = null;
  createdAdminLink: string | null = null;
  createdTournamentId: string | null = null;

  joinTournamentId = '';

  async create(): Promise<void> {
    const name = this.name.trim();
    if (!name) return;
    this.busy = true;
    this.error = null;
    try {
      const res = await this.api.createTournament(name);
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

  copied = false;

  async copyAdminLink(): Promise<void> {
    if (!this.createdAdminLink) return;
    this.copied = await copyToClipboard(this.createdAdminLink);
  }
}
