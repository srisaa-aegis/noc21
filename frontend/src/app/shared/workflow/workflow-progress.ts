import { Component, computed, input } from '@angular/core';
import { currentTasks, outcomeLabel, roleCode, taskDaysPending, taskSlaDays } from '../../core/domain/workflow';
import { DeptRole, FormDef, SlaConfig, TaskState, WorkflowRun, WorkflowTask } from '../../core/models';
import { IconComponent } from '../ui/icon';

export interface StepRow {
  task: WorkflowTask;
  role: string;
  form: string;
  days: number | null;
  sla: number | null;
  overdue: boolean;
}

const STATE_LABEL: Record<TaskState, string> = {
  waiting: 'Waiting',
  active: 'In progress',
  done: 'Done',
  skipped: 'Bypassed',
  sent_back: 'Sent back',
  not_required: 'Not required',
};

/**
 * Read-only view of a workflow run: the stages as a stepper (parallel tasks under each stage, with
 * the officer and state) and the legacy "process steps" table (every row incl. sent-back rounds).
 */
@Component({
  selector: 'app-workflow-progress',
  imports: [IconComponent],
  templateUrl: './workflow-progress.html',
  styleUrl: './workflow-progress.scss',
})
export class WorkflowProgress {
  readonly run = input.required<WorkflowRun>();
  readonly roles = input<DeptRole[]>([]);
  readonly forms = input<FormDef[]>([]);
  readonly sla = input<SlaConfig | null>(null);
  readonly now = input<Date>(new Date());
  /** Task highlighted (e.g. the officer's own task). */
  readonly highlight = input<number | null>(null);
  readonly showTable = input(true);
  /** Citizen view: stages and their state only (no officers, no internal remarks). */
  readonly compact = input(false);

  protected readonly stateLabel = STATE_LABEL;
  protected readonly outcomeLabel = outcomeLabel;

  protected readonly stages = computed(() => {
    const run = this.run();
    const current = currentTasks(run);
    return run.stages.map((s, i) => {
      const tasks = current.filter((t) => t.stage_key === s.key);
      const state: TaskState = tasks.some((t) => t.state === 'active')
        ? 'active'
        : tasks.every((t) => t.state === 'not_required')
          ? 'not_required'
          : tasks.every((t) => t.state === 'done' || t.state === 'skipped' || t.state === 'not_required')
            ? 'done'
            : 'waiting';
      return { index: i + 1, def: s, tasks, state, final: i === run.stages.length - 1 };
    });
  });

  protected readonly rows = computed<StepRow[]>(() => {
    const run = this.run();
    const sla = this.sla();
    return [...run.tasks]
      .filter((t) => t.state !== 'waiting' && t.state !== 'not_required')
      .sort((a, b) => a.task_id - b.task_id)
      .map((t) => {
        const slaDays = sla ? taskSlaDays(run, t, sla, this.forms()) : null;
        const days = t.state === 'active' ? taskDaysPending(t, this.now()) : null;
        return {
          task: t,
          role: roleCode(t.role_id, this.roles()),
          form: this.forms().find((f) => f.id === t.form)?.name ?? t.form,
          days,
          sla: slaDays,
          overdue: days != null && slaDays != null && days > slaDays,
        };
      });
  });

  protected roleOf(t: WorkflowTask): string {
    return roleCode(t.role_id, this.roles());
  }

  protected stageName(key: string | undefined): string {
    return this.run().stages.find((s) => s.key === key)?.name ?? key ?? '';
  }
}
