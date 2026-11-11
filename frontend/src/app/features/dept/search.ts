import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApplicationSummary } from '../../core/models';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { StatusBadge } from '../../shared/ui/status-badge';
import { DeptWorkflowService } from './dept-workflow.service';

/** Department search over the submitted applications of the officer's jurisdiction (searched on the server). */
@Component({
  selector: 'app-search',
  imports: [ApplTypeBadge, StatusBadge, RouterLink],
  templateUrl: './search.html',
  styleUrl: './search.scss',
})
export class Search {
  private readonly dept = inject(DeptWorkflowService);

  protected readonly query = signal('');
  protected readonly results = signal<ApplicationSummary[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const q = this.query().trim();
      untracked(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.search(q), q ? 250 : 0);
      });
    });
  }

  private search(q: string): void {
    this.loading.set(true);
    this.dept.search({ text: q || undefined, pageSize: 100 }).subscribe({
      next: (r) => {
        this.results.set(r.items);
        this.total.set(r.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
