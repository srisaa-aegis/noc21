import { Component, computed, input } from '@angular/core';
import { StatusId } from '../../core/models';
import { statusPresentation } from '../status.util';

@Component({
  selector: 'app-status-badge',
  templateUrl: './status-badge.html',
  styleUrl: './status-badge.scss',
})
export class StatusBadge {
  readonly statusId = input.required<StatusId>();
  readonly dateLabel = input<string | undefined>(undefined);

  protected readonly presentation = computed(() => statusPresentation(this.statusId()));
}
