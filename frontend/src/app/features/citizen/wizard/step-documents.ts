import { Component, computed, inject, output } from '@angular/core';
import { WizardTarget } from '../../../core/domain/wizard-steps';
import { IconComponent } from '../../../shared/ui/icon';
import { ApplicationDraftStore } from './application-draft.store';
import { DocList } from './doc-list';

/** Supporting documents of the application (legacy editpnoc.html upload section). Block plans are uploaded in each block's flow. */
@Component({
  selector: 'app-step-documents',
  imports: [IconComponent, DocList],
  templateUrl: './step-documents.html',
  styleUrl: './step-documents.scss',
})
export class StepDocuments {
  protected readonly store = inject(ApplicationDraftStore);

  readonly open = output<WizardTarget>();

  protected readonly general = computed(() => this.store.requiredDocs().filter((d) => d.group === 'general'));

  protected readonly progress = computed(() => {
    const required = this.general().filter((d) => !d.optional);
    const done = required.filter((d) => this.store.documentFor(d.code)).length;
    return { done, total: required.length };
  });

  /** Plans status per block (uploaded in the block flow). */
  protected readonly blockPlans = computed(() => {
    const docs = this.store.requiredDocs().filter((d) => d.group === 'plans');
    return (this.store.app()?.blocks ?? []).map((b) => {
      const mine = docs.filter((d) => d.blockId === b.block_id);
      return { block: b, total: mine.length, done: mine.filter((d) => this.store.documentFor(d.code)).length };
    });
  });
}
