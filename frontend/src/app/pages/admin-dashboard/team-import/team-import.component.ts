import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAX_TEAM_IMPORT_ROWS,
  NAF_NUMBER_PATTERN,
  RACES,
  derivePasswordFromCoachName,
  matchRace,
  type AdminTournamentView,
  type ImportTeamRow,
} from '@bb-tournament/shared';
import { ApiService } from '../../../core/api.service';
import { parseCsv } from '../../../core/csv';
import { extractErrorMessage } from '../../../core/http-error';

const MAX_COACH_NAME_LENGTH = 40;
const MAX_SQUAD_NAME_LENGTH = 40;
const HEADER_ROW_KEYWORDS = ['coach', 'nom', 'coachname', 'coach name', 'nom du coach', 'nom coach', 'coach name'];
const SQUAD_HEADER_ROW_KEYWORDS = ['squad', 'escouade', "nom de l'escouade", 'nom escouade'];

interface PreviewRow {
  lineNo: number;
  squadName: string;
  coachName: string;
  rawRace: string;
  matchedRace: string | null;
  raceOverride: string | null;
  nafNumber: string;
}

@Component({
  selector: 'app-team-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './team-import.component.html',
  styleUrl: './team-import.component.scss',
})
export class TeamImportComponent {
  @Input({ required: true }) tournamentId!: string;
  @Input({ required: true }) token!: string;
  @Input({ required: true }) tournament!: AdminTournamentView;
  @Output() imported = new EventEmitter<AdminTournamentView>();

  private readonly api = inject(ApiService);

  readonly races = RACES;
  readonly maxRows = MAX_TEAM_IMPORT_ROWS;

  csvText = '';
  rows: PreviewRow[] = [];
  parseError: string | null = null;

  busy = false;
  submitError: string | null = null;
  importedCount: number | null = null;

  get isTeamFormat(): boolean {
    return this.tournament.format === 'team';
  }

  analyze(): void {
    this.submitError = null;
    this.importedCount = null;
    this.parseError = null;
    this.rows = [];

    const parsed = parseCsv(this.csvText);
    if (parsed.length === 0) return;

    const dataRows = this.looksLikeHeaderRow(parsed[0]) ? parsed.slice(1) : parsed;
    if (dataRows.length === 0) return;
    if (dataRows.length > this.maxRows) {
      this.parseError = `Maximum ${this.maxRows} lignes par import (${dataRows.length} détectées).`;
      return;
    }

    this.rows = dataRows.map((cells, i) => this.buildRow(i + 1, cells));
  }

  private looksLikeHeaderRow(cells: string[]): boolean {
    const first = (cells[0] ?? '').trim().toLowerCase();
    if (this.isTeamFormat) return SQUAD_HEADER_ROW_KEYWORDS.includes(first);
    return HEADER_ROW_KEYWORDS.includes(first);
  }

  /** Team-format tournaments have an extra leading squad-name column; individual ones stay as-is. */
  private buildRow(lineNo: number, cells: string[]): PreviewRow {
    const offset = this.isTeamFormat ? 1 : 0;
    const squadName = this.isTeamFormat ? (cells[0] ?? '').trim() : '';
    const coachName = (cells[offset] ?? '').trim();
    const rawRace = (cells[offset + 1] ?? '').trim();
    const nafNumber = (cells[offset + 2] ?? '').trim();
    const matched = rawRace ? matchRace(rawRace) : null;
    return { lineNo, squadName, coachName, rawRace, matchedRace: matched?.race ?? null, raceOverride: null, nafNumber };
  }

  resolvedRace(row: PreviewRow): string | null {
    return row.raceOverride ?? row.matchedRace;
  }

  removeRow(index: number): void {
    this.rows.splice(index, 1);
  }

  /** Counts an existing squad's current members plus every earlier batch row naming the same squad. */
  private squadCapacityError(row: PreviewRow, index: number): string | null {
    const squadSize = this.tournament.squadSize;
    if (squadSize == null) return null;
    const lowerSquad = row.squadName.toLowerCase();
    const existingSquad = this.tournament.squads.find((s) => s.name.toLowerCase() === lowerSquad);
    const existingCount = existingSquad
      ? this.tournament.teams.filter((tm) => tm.squadId === existingSquad.id).length
      : 0;
    const priorInBatch = this.rows.slice(0, index).filter((r) => r.squadName.toLowerCase() === lowerSquad).length;
    if (existingCount + priorInBatch >= squadSize) {
      return `Escouade "${row.squadName}" complète (max ${squadSize})`;
    }
    return null;
  }

  rowErrors(row: PreviewRow, index: number): string[] {
    const errors: string[] = [];
    if (this.isTeamFormat) {
      if (!row.squadName) errors.push("Nom d'escouade manquant");
      else if (row.squadName.length > MAX_SQUAD_NAME_LENGTH) errors.push("Nom d'escouade trop long");
      else {
        const capacityError = this.squadCapacityError(row, index);
        if (capacityError) errors.push(capacityError);
      }
    }
    if (!row.coachName) errors.push('Nom de coach manquant');
    else if (row.coachName.length > MAX_COACH_NAME_LENGTH) errors.push('Nom de coach trop long');
    if (!row.rawRace) errors.push('Race manquante');
    else if (!this.resolvedRace(row)) errors.push('Race non reconnue — choisissez-la manuellement');
    if (row.nafNumber && !NAF_NUMBER_PATTERN.test(row.nafNumber)) errors.push('Numéro NAF invalide');

    const lowerCoach = row.coachName.toLowerCase();
    if (lowerCoach) {
      if (this.rows.some((r, i) => i !== index && r.coachName.toLowerCase() === lowerCoach)) {
        errors.push('Coach en double dans le fichier');
      }
      const password = derivePasswordFromCoachName(row.coachName);
      if (this.tournament.teams.some((tm) => tm.coachName.toLowerCase() === lowerCoach && tm.password === password)) {
        errors.push('Ce coach est déjà inscrit dans ce tournoi');
      }
      if (this.tournament.teams.some((tm) => tm.name.toLowerCase() === lowerCoach)) {
        errors.push("Le nom d'équipe (= nom du coach) est déjà utilisé");
      }
    }
    return errors;
  }

  get hasErrors(): boolean {
    return this.rows.some((row, i) => this.rowErrors(row, i).length > 0);
  }

  async submit(): Promise<void> {
    if (this.rows.length === 0 || this.hasErrors) return;
    this.busy = true;
    this.submitError = null;
    this.importedCount = null;
    try {
      const payload: ImportTeamRow[] = this.rows.map((row) => ({
        squadName: this.isTeamFormat ? row.squadName : undefined,
        coachName: row.coachName,
        race: this.resolvedRace(row)!,
        nafNumber: row.nafNumber || undefined,
      }));
      const res = await this.api.importTeams(this.tournamentId, this.token, payload);
      this.importedCount = res.teamIds.length;
      this.rows = [];
      this.csvText = '';
      const tournament = await this.api.getAdminTournament(this.tournamentId, this.token);
      this.imported.emit(tournament);
    } catch (err) {
      this.submitError = extractErrorMessage(err);
    } finally {
      this.busy = false;
    }
  }
}
