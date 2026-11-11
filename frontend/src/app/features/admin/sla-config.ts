import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { roleCode, slaProblems } from '@srisaa/noc-domain';
import { SlaConfig, WorkflowDefinition } from '../../core/models';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkflowAdminData, WorkflowsAdminService } from './workflows-admin.service';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface StepRow {
  key: string;
  name: string;
  role: string;
  inspection: boolean;
}

/**
 * Admin → SLA & Escalations: per workflow the days allowed for each step, for the inspection and for
 * the whole processing (once the processing SLA is crossed the issuing authority can only approve or
 * reject), and who "Send Escalations" reminds (officer, issuing authority) and how often.
 */
@Component({
  selector: 'app-sla-config',
  imports: [FormsModule, RouterLink, IconComponent],
  templateUrl: './sla-config.html',
  styleUrl: './sla-config.scss',
})
export class SlaConfigPage {
  private readonly service = inject(WorkflowsAdminService);
  private readonly toast = inject(ToastService);

  protected readonly data = signal<WorkflowAdminData | null>(null);
  protected readonly draft = signal<SlaConfig | null>(null);
  private original = '';
  private readonly rev = signal(0);
  protected readonly saving = signal(false);

  protected readonly workflows = computed(() => {
    const d = this.data();
    if (!d) return [];
    return d.workflows.map((w) => ({ def: w, steps: this.stepsOf(w) }));
  });

  protected readonly problems = computed(() => {
    this.rev();
    const s = this.draft();
    const d = this.data();
    return s && d ? slaProblems(s, d.workflows) : [];
  });

  protected readonly dirty = computed(() => {
    this.rev();
    return !!this.draft() && JSON.stringify(this.draft()) !== this.original;
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.service.load().subscribe((d) => {
      this.data.set(d);
      const sla = clone(d.sla);
      this.original = JSON.stringify(sla);
      // every workflow and every non-inspection step gets an entry (defaults shown, saved with the next save)
      for (const w of d.workflows) {
        const s = (sla.workflows[w.code] ??= { processing_days: 30, inspection_days: 10, step_days: {} });
        for (const st of this.stepsOf(w)) if (!st.inspection && s.step_days[st.key] == null) s.step_days[st.key] = 7;
      }
      this.draft.set(sla);
      this.touch();
    });
  }

  private stepsOf(w: WorkflowDefinition): StepRow[] {
    const d = this.data();
    const seen = new Set<string>();
    const out: StepRow[] = [];
    for (const s of w.stages) {
      for (const t of s.tasks) {
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        out.push({ key: t.key, name: t.name, role: roleCode(t.role_id, d?.roles ?? []), inspection: !!d?.forms.find((f) => f.id === t.form)?.inspection });
      }
    }
    return out;
  }

  protected touch(): void {
    this.rev.update((n) => n + 1);
  }

  protected sumOfSteps(id: string, steps: StepRow[]): number {
    this.rev();
    const s = this.draft()?.workflows[id];
    if (!s) return 0;
    const hasInspection = steps.some((x) => x.inspection);
    return steps.filter((x) => !x.inspection).reduce((n, x) => n + (Number(s.step_days[x.key]) || 0), 0) + (hasInspection ? Number(s.inspection_days) || 0 : 0);
  }

  protected save(): void {
    const s = this.draft();
    if (!s || this.problems().length) return;
    this.saving.set(true);
    this.service.saveSla(clone(s)).subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.success('SLA and escalation settings saved.');
        this.load();
      },
      error: (e: Error) => {
        this.saving.set(false);
        this.toast.error(e.message);
      },
    });
  }

  protected discard(): void {
    this.load();
  }
}
