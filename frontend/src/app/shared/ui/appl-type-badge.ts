import { Component, computed, input } from '@angular/core';
import { ApplicationTypeCode } from '../../core/models';
import { applTypePresentation } from '../status.util';
import { IconComponent } from './icon';

@Component({
  selector: 'app-appl-type-badge',
  imports: [IconComponent],
  templateUrl: './appl-type-badge.html',
  styleUrl: './appl-type-badge.scss',
})
export class ApplTypeBadge {
  readonly applType = input.required<ApplicationTypeCode>();

  protected readonly presentation = computed(() => applTypePresentation(this.applType()));
}
