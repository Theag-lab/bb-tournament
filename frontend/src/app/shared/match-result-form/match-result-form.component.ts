import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { MatchResult, SubmitResultRequest } from '@bb-tournament/shared';

@Component({
  selector: 'app-match-result-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './match-result-form.component.html',
  styleUrl: './match-result-form.component.scss',
})
export class MatchResultFormComponent implements OnChanges {
  @Input({ required: true }) team1Id!: string;
  @Input({ required: true }) team2Id!: string;
  @Input({ required: true }) team1Name!: string;
  @Input({ required: true }) team2Name!: string;
  @Input() submitLabel = 'Envoyer le résultat';
  @Input() initial: MatchResult | null = null;
  @Input() busy = false;

  @Output() submitResult = new EventEmitter<SubmitResultRequest>();

  team1Td = 0;
  team2Td = 0;
  team1Cas = 0;
  team2Cas = 0;
  concededBy: '' | 'team1' | 'team2' = '';

  ngOnChanges(): void {
    if (this.initial) {
      this.team1Td = this.initial.team1Td;
      this.team2Td = this.initial.team2Td;
      this.team1Cas = this.initial.team1Cas;
      this.team2Cas = this.initial.team2Cas;
      this.concededBy = this.initial.concededByTeamId
        ? this.initial.concededByTeamId === this.team1Id
          ? 'team1'
          : 'team2'
        : '';
    }
  }

  get isConcession(): boolean {
    return this.concededBy !== '';
  }

  submit(): void {
    const concededByTeamId =
      this.concededBy === 'team1' ? this.team1Id : this.concededBy === 'team2' ? this.team2Id : null;
    this.submitResult.emit({
      team1Td: this.team1Td,
      team2Td: this.team2Td,
      team1Cas: this.team1Cas,
      team2Cas: this.team2Cas,
      concededByTeamId,
    });
  }
}
