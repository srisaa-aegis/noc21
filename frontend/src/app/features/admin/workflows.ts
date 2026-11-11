import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { roleCode, workflowSetProblems } from '@srisaa/noc-domain';
import { DelegationLevel, WorkflowDefinition } from '../../core/models';
import { IconComponent } from '../../shared/ui/icon';
import { WorkflowAdminData, WorkflowsAdminService } from './workflows-admin.service';

interface Cell {
  def: WorkflowDefinition | undefined;
  decisionRole: string;
  stages: { name: string; parallel: number; onDemand: boolean }[];
  inProcess: number;
  total: number;
}

/** Admin → Workflows: one workflow per application type × approval level. */
@Component({
  selector: 'app-admin-workflows',
  imports: [RouterLink, IconComponent],
  templateUrl: './workflows.html',
  styleUrl: './workflows.scss',
})
export class Workflows {
  private readonly service = inject(WorkflowsAdminService);

  protected readonly data = signal<WorkflowAdminData | null>(null);
  protected readonly types: { code: WorkflowDefinition['appl_type']; name: string }[] = [
    { code: 'P', name: 'Provisional NOC' },
    { code: 'O', name: 'Occupancy NOC' },
    { code: 'R', name: 'Renewal of Occupancy NOC' },
    { code: 'D', name: 'Declaration for Renewal' },
  ];
  protected readonly levels: { code: DelegationLevel; name: string }[] = [
    { code: 'MSB', name: 'Head Office (MSB)' },
    { code: 'RFO', name: 'Regional (RFO)' },
    { code: 'DFO', name: 'District (DFO)' },
  ];

  protected readonly problems = computed(() => {
    const d = this.data();
    return d ? workflowSetProblems(d.workflows, d.roles, d.forms) : [];
  });

  protected readonly cells = computed(() => {
    const d = this.data();
    const out: Record<string, Cell> = {};
    if (!d) return out;
    for (const t of this.types) {
      for (const l of this.levels) {
        const def = d.workflows.find((w) => w.appl_type === t.code && w.level === l.code);
        const usage = def ? Object.values(d.usage[def.code] ?? {}) : [];
        const last = def?.stages[def.stages.length - 1];
        out[`${t.code}-${l.code}`] = {
          def,
          decisionRole: last?.tasks[0] ? roleCode(last.tasks[0].role_id, d.roles) : '—',
          stages: (def?.stages ?? []).map((s) => ({ name: s.name, parallel: s.tasks.length, onDemand: s.tasks.every((x) => x.on_demand) })),
          inProcess: usage.reduce((n, u) => n + u.inProcess, 0),
          total: usage.reduce((n, u) => n + u.total, 0),
        };
      }
    }
    return out;
  });

  constructor() {
    this.service.load().subscribe((d) => this.data.set(d));
  }
}
