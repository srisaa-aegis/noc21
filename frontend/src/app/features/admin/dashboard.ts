import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { AccountsService } from '../../core/accounts/accounts.service';
import { EscalationNotice } from '../../core/models';
import { Modal } from '../../shared/ui/modal';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { AdminService, EscalationPreview, UnassignedTask } from './admin.service';

interface Stats {
  citizens: number;
  citizensInactive: number;
  deptUsers: number;
  deptInactive: number;
  applications: number;
  drafts: number;
  staleDrafts: number;
}

/**
 * Admin Workbench: counters (computed by the server), escalations, unassigned
 * tasks and the configuration pages. The demo reset is not here (Q-67): it is a
 * guarded command-line script (`npm run dev:reset-demo`).
 */
@Component({
  selector: 'app-dashboard',
  imports: [IconComponent, RouterLink, Modal],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly adminService = inject(AdminService);
  private readonly accounts = inject(AccountsService);
  private readonly toast = inject(ToastService);

  protected readonly sending = signal(false);
  protected readonly stats = signal<Stats>({ citizens: 0, citizensInactive: 0, deptUsers: 0, deptInactive: 0, applications: 0, drafts: 0, staleDrafts: 0 });
  protected readonly unassigned = signal<UnassignedTask[]>([]);
  protected readonly assignTo: Record<string, number> = {};

  constructor() {
    this.load();
  }

  private load(): void {
    const total = (portal: 'citizen' | 'dept', active?: boolean) => this.accounts.page({ portal, active, pageSize: 1 });
    forkJoin({
      citizens: total('citizen'),
      citizensInactive: total('citizen', false),
      deptUsers: total('dept'),
      deptInactive: total('dept', false),
      applications: this.adminService.count({}),
      drafts: this.adminService.count({ draftsOnly: true }),
      staleDrafts: this.adminService.count({ draftsOnly: true, staleDays: 180 }),
    }).subscribe((r) =>
      this.stats.set({
        citizens: r.citizens.total,
        citizensInactive: r.citizensInactive.total,
        deptUsers: r.deptUsers.total,
        deptInactive: r.deptInactive.total,
        applications: r.applications,
        drafts: r.drafts,
        staleDrafts: r.staleDrafts,
      }),
    );
    this.adminService.unassignedTasks().subscribe((list) => {
      this.unassigned.set(list);
      for (const u of list) this.assignTo[`${u.appl_id}/${u.task.task_id}`] ??= u.candidates[0]?.id;
    });
  }

  /** Escalation preview (null = closed). */
  protected readonly preview = signal<EscalationPreview | null>(null);

  protected readonly kindLabel: Record<EscalationNotice['kind'], string> = { step: 'Step SLA', inspection: 'Inspection SLA', processing: 'Processing SLA' };

  protected openEscalations(): void {
    this.adminService.escalationPreview().subscribe((p) => this.preview.set(p));
  }

  protected sendEscalations(): void {
    this.sending.set(true);
    this.adminService.sendEscalations().subscribe({
      next: (entry) => {
        this.sending.set(false);
        this.preview.set(null);
        this.toast.success(
          entry.notices.length === 0
            ? 'Nothing is due — no escalation sent.'
            : `Escalation reminders sent to ${entry.recipients} officer(s) for ${entry.notices.length} overdue item(s) in ${entry.applications} application(s).`,
        );
      },
      error: (e: Error) => {
        this.sending.set(false);
        this.toast.error(e.message);
      },
    });
  }

  protected assign(u: UnassignedTask): void {
    const to = this.assignTo[`${u.appl_id}/${u.task.task_id}`];
    if (!to) return;
    this.adminService.assignTask(u.appl_id, u.task.task_id, Number(to)).subscribe({
      next: () => {
        this.toast.success(`${u.task.name} of ${u.appl_number} assigned.`);
        this.load();
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }
}
