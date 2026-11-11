import { Component, computed, inject, input } from '@angular/core';
import { ApplicationDraftStore } from './application-draft.store';
import { DocList } from './doc-list';

/** Block flow, last page — legacy editpnoc_4.html: the plans & drawings of one block (PDF). */
@Component({
  selector: 'app-step-block-plans',
  imports: [DocList],
  template: `
    <section class="form-section">
      <h3>Plans &amp; Drawings</h3>
      <p class="form-section__intro">
        Upload the site plan, section plan, elevation plan and a plan of every floor of this block as PDF files (max 10 MB each).
        <strong>{{ done() }} of {{ docs().length }}</strong> attached.
      </p>
      <app-doc-list [docs]="docs()"></app-doc-list>
    </section>
  `,
})
export class StepBlockPlans {
  protected readonly store = inject(ApplicationDraftStore);

  readonly index = input.required<number>();

  protected readonly docs = computed(() => {
    const block = this.store.app()?.blocks[this.index()];
    return this.store.requiredDocs().filter((d) => d.group === 'plans' && d.blockId === block?.block_id);
  });

  protected readonly done = computed(() => this.docs().filter((d) => this.store.documentFor(d.code)).length);
}
