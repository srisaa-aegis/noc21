import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  CHALLAN_VERIFIED,
  isProcessingOverdue,
  processingDays,
  slaFor,
  taskDaysPending,
  taskDefOf,
  taskSlaDays,
  type DecisionInput,
} from '@srisaa/noc-domain';
import { AuthService } from '../../core/auth/auth.service';
import { delegationLevelName } from '../../core/domain/application-rules';
import { validateUpload } from '../../core/domain/documents';
import {
  CommitteeConcurrenceData,
  InspectionReportData,
  QuestionnaireData,
  RfoNoteData,
  SectionNoteData,
  initialTaskFormData,
  taskFormProblems,
} from '../../core/domain/task-forms';
import { LookupService, WizardLookups, WorkflowConfig } from '../../core/lookups/lookup.service';
import { Application, DistrictFireStations, WorkflowOutcome, WorkflowTask, WorkflowTaskDef } from '../../core/models';
import { ApplicationSheet } from '../../shared/application-sheet/application-sheet';
import { FileLink } from '../../shared/files/file-link';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { IconComponent } from '../../shared/ui/icon';
import { Modal } from '../../shared/ui/modal';
import { StatusBadge } from '../../shared/ui/status-badge';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkflowProgress } from '../../shared/workflow/workflow-progress';
import { AllowedActions, DeptView, DeptWorkflowService } from './dept-workflow.service';
import { CommitteeConcurrenceForm } from './forms/committee-concurrence-form';
import { FinalDecisionForm } from './forms/final-decision-form';
import { InspectionReportForm } from './forms/inspection-report-form';
import { QuestionnaireForm } from './forms/questionnaire-form';
import { RfoNoteForm } from './forms/rfo-note-form';
import { SectionNoteForm } from './forms/section-note-form';

type Tab = 'workflow' | 'application' | 'documents' | 'correspondence' | 'timeline';
type ModalKind = 'sendback' | 'bypass' | 'reassign' | 'request_doc' | 'upload_doc' | 'sms' | 'fire_station' | 'lic_auth';

interface MyTask {
  task: WorkflowTask;
  def: WorkflowTaskDef | undefined;
  allowed: AllowedActions['tasks'][number];
  days: number;
  sla: number;
  formName: string;
}

interface PendingRow {
  task: WorkflowTask;
  canSkip: boolean;
  canReassign: boolean;
  isMine: boolean;
}

/**
 * Department processing page of one application (legacy application.aspx + process_steps.aspx +
 * process_move.aspx / sendback.aspx / reassign.aspx / uploaddeptdocs.aspx / sendsms.aspx /
 * update_application.aspx). What the officer may do comes from the server's workflow engine
 * (`allowed_actions`); every action is a server transaction that returns the updated page.
 */
@Component({
  selector: 'app-dept-application-view',
  imports: [
    RouterLink,
    FormsModule,
    ApplTypeBadge,
    StatusBadge,
    IconComponent,
    ApplicationSheet,
    WorkflowProgress,
    Modal,
    FileLink,
    SectionNoteForm,
    InspectionReportForm,
    CommitteeConcurrenceForm,
    RfoNoteForm,
    QuestionnaireForm,
    FinalDecisionForm,
  ],
  templateUrl: './application-view.html',
  styleUrl: './application-view.scss',
})
export class ApplicationView {
  private readonly dept = inject(DeptWorkflowService);
  private readonly lookupService = inject(LookupService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  /** Route param / query param, bound via withComponentInputBinding. */
  readonly id = input.required<string>();
  readonly task = input<string | undefined>(undefined);

  private readonly view = signal<DeptView | null>(null);
  protected readonly app = computed(() => this.view()?.application ?? null);
  protected readonly allowed = computed(() => this.view()?.allowed_actions ?? null);
  protected readonly parent = computed(() => this.view()?.parent ?? null);
  protected readonly cfg = signal<WorkflowConfig | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly tab = signal<Tab>('workflow');
  protected readonly lookups = toSignal<WizardLookups | null>(this.lookupService.wizard(), { initialValue: null });
  protected readonly now = new Date();
  protected readonly me = computed(() => this.auth.session()?.username ?? '');
  protected readonly challanField = CHALLAN_VERIFIED;

  protected readonly tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'workflow', label: 'Workflow', icon: 'layers' },
    { id: 'application', label: 'Application', icon: 'file' },
    { id: 'documents', label: 'Documents', icon: 'paperclip' },
    { id: 'correspondence', label: 'SMS', icon: 'bell' },
    { id: 'timeline', label: 'Process log', icon: 'clock' },
  ];

  protected readonly run = computed(() => this.app()?.workflow ?? null);
  protected readonly isApprover = computed(() => !!this.allowed()?.is_decider);

  /** The open tasks of the signed-in officer on this application. */
  protected readonly myOpenTasks = computed<MyTask[]>(() => {
    const run = this.run();
    const cfg = this.cfg();
    const allowed = this.allowed();
    if (!run || !cfg || !allowed) return [];
    return allowed.tasks
      .map((a) => {
        const t = run.tasks.find((x) => x.task_id === a.task_id);
        if (!t) return null;
        return {
          task: t,
          def: taskDefOf(run.stages, t.stage_key, t.task_key),
          allowed: a,
          days: taskDaysPending(t, this.now),
          sla: taskSlaDays(run, t, cfg.sla, cfg.forms),
          formName: cfg.forms.find((f) => f.id === t.form)?.name ?? t.form,
        };
      })
      .filter((x): x is MyTask => !!x);
  });

  protected readonly selectedTaskId = signal<number | null>(null);

  protected readonly selected = computed<MyTask | null>(() => {
    const mine = this.myOpenTasks();
    if (!mine.length) return null;
    return mine.find((t) => t.task.task_id === this.selectedTaskId()) ?? mine[0];
  });

  /** Plain number (not a fresh object each time), so the reset effect below only fires when the task actually changes. */
  private readonly selectedTaskKey = computed(() => this.selected()?.task.task_id ?? null);

  protected readonly selectedForm = computed(() => this.cfg()?.forms.find((f) => f.id === this.selected()?.def?.form));
  protected readonly isDecisionTask = computed(() => !!this.selected()?.allowed.decide);
  protected readonly challanCheck = computed(() => !!this.selected()?.allowed.challan_check);

  /** Bumped whenever a sub-form mutates its (non-signal) working data, so `problems` recomputes. */
  private readonly rev = signal(0);
  protected readonly taskData = signal<Record<string, unknown> | null>(null);

  /** The same checks the server runs on submit, shown while the form is filled in. */
  protected readonly problems = computed(() => {
    this.rev();
    const f = this.selectedForm();
    const d = this.taskData();
    const a = this.app();
    if (!f || !d || !a || this.isDecisionTask()) return [];
    const out = taskFormProblems(f, d, a);
    if (this.challanCheck() && d[CHALLAN_VERIFIED] !== 'Y') out.push('Verify the bank challan and tick "Challan verified".');
    return out;
  });

  protected readonly saving = signal(false);
  protected readonly submitting = signal(false);

  protected readonly highlight = computed(() => {
    const q = Number(this.task());
    return q || this.selected()?.task.task_id || null;
  });

  protected readonly processing = computed(() => {
    const a = this.app();
    const cfg = this.cfg();
    if (!a?.workflow || !cfg) return null;
    return {
      days: processingDays(a, this.now),
      sla: slaFor(a, cfg.sla)?.processing_days ?? null,
      overdue: isProcessingOverdue(a, cfg.sla, this.now),
      complete: !!a.workflow.completed_on,
    };
  });

  /** Decision outcomes still allowed (the server removes "return" once the processing SLA is crossed). */
  protected readonly allowedDecisionOutcomes = computed<WorkflowOutcome[]>(() => (this.isDecisionTask() ? (this.allowed()?.outcomes ?? []) : []));

  protected readonly stationName = computed(() => {
    const a = this.app();
    const l = this.lookups();
    if (!a || !l) return '';
    return l.fireStations.find((d) => d.id === a.district)?.stations.find((s) => s.id === a.fire_station_id)?.name ?? String(a.fire_station_id || '—');
  });

  protected readonly history = computed(() => [...(this.app()?.workflow_history ?? [])].reverse());

  /** Pending tasks the issuing authority may bypass or reassign. */
  protected readonly pendingOfficers = computed<PendingRow[]>(() => {
    const run = this.run();
    const allowed = this.allowed();
    if (!run || !allowed) return [];
    const ids = new Set([...allowed.skip, ...allowed.reassign]);
    return run.tasks
      .filter((t) => ids.has(t.task_id) && (t.state === 'active' || t.state === 'waiting'))
      .map((t) => ({ task: t, canSkip: allowed.skip.includes(t.task_id), canReassign: allowed.reassign.includes(t.task_id), isMine: t.assignee === this.me() }));
  });

  protected readonly canChangeFireStation = computed(() => !!this.allowed()?.change_fire_station);

  protected readonly canUpdateLicAuth = computed(() => {
    const a = this.app();
    return !!a && (a.appl_type === 'P' || a.appl_type === 'O') && !!this.allowed()?.update_licensing_authority;
  });

  protected readonly canUploadOrSms = computed(() => !!this.allowed()?.upload_documents);

  // --- generic action modal ---------------------------------------------------

  protected readonly modal = signal<ModalKind | null>(null);
  protected readonly modalBusy = signal(false);
  protected modalTask: PendingRow | null = null;
  protected comments = '';
  protected reassignTo: number | null = null;
  protected requestDocDesc = '';
  protected uploadFile: File | null = null;
  protected uploadDesc = '';
  protected smsMessage = '';
  protected newDistrict = 0;
  protected newStation: number | null = null;
  protected licAuth = '';
  protected licAddr = '';

  protected readonly districts = toSignal(this.lookupService.districts$, { initialValue: [] });
  protected readonly fireStations = toSignal(this.lookupService.fireStations$, { initialValue: [] as DistrictFireStations[] });

  /**
   * Plain methods (not `computed()`): `newDistrict` / `modalTask` are plain fields (bound with
   * `[(ngModel)]` or set from a click handler, not signals).
   */
  protected newStations(): { id: number; name: string }[] {
    return this.fireStations().find((d) => d.id === Number(this.newDistrict))?.stations ?? [];
  }

  protected reassignCandidates(): { id: number; username: string; displayName: string }[] {
    const row = this.modalTask;
    if (!row) return [];
    return (this.allowed()?.reassign_candidates[row.task.task_id] ?? []).filter((u) => u.username !== row.task.assignee);
  }

  constructor() {
    effect(() => {
      const id = Number(this.id());
      untracked(() => this.load(id));
    });
    // reload the working data only when the selected task itself changes (not on every app refresh)
    effect(() => {
      const key = this.selectedTaskKey();
      untracked(() => this.resetTaskData(key));
    });
    this.lookupService.workflowConfig().subscribe((c) => this.cfg.set(c));
  }

  private load(id: number): void {
    this.loading.set(true);
    this.dept.view(id).subscribe({
      next: (v) => {
        this.view.set(v);
        this.notFound.set(false);
        this.loading.set(false);
        if (this.task()) this.selectedTaskId.set(Number(this.task()));
      },
      error: () => {
        this.notFound.set(true);
        this.loading.set(false);
      },
    });
  }

  private resetTaskData(taskId: number | null): void {
    const sel = this.myOpenTasks().find((t) => t.task.task_id === taskId);
    const app = this.app();
    const form = this.cfg()?.forms.find((f) => f.id === sel?.def?.form);
    if (!sel || !app || !form || this.isDecisionTask()) {
      this.taskData.set(null);
      return;
    }
    const initial = initialTaskFormData(form, app, this.auth.session()?.displayName ?? this.me(), sel.task.start_date ?? app.applied_date);
    const saved = sel.task.data && Object.keys(sel.task.data).length ? sel.task.data : {};
    this.taskData.set({ ...initial, ...saved });
    this.rev.update((n) => n + 1);
  }

  protected selectTask(taskId: number): void {
    this.selectedTaskId.set(taskId);
  }

  protected isSelectedTask(taskId: number): boolean {
    return this.selected()?.task.task_id === taskId;
  }

  protected onFormChanged(): void {
    this.rev.update((n) => n + 1);
  }

  protected setChallanVerified(checked: boolean): void {
    const d = this.taskData();
    if (!d) return;
    d[CHALLAN_VERIFIED] = checked ? 'Y' : '';
    this.onFormChanged();
  }

  // Typed views of the generic `taskData` record for each structured form component (strictTemplates).
  protected sectionNoteData(): SectionNoteData {
    return this.taskData() as unknown as SectionNoteData;
  }

  protected inspectionReportData(): InspectionReportData {
    return this.taskData() as unknown as InspectionReportData;
  }

  protected committeeConcurrenceData(): CommitteeConcurrenceData {
    return this.taskData() as unknown as CommitteeConcurrenceData;
  }

  protected rfoNoteData(): RfoNoteData {
    return this.taskData() as unknown as RfoNoteData;
  }

  protected questionnaireData(): QuestionnaireData {
    return this.taskData() as unknown as QuestionnaireData;
  }

  private applyUpdated(v: DeptView, message: string): void {
    this.view.set(v);
    this.toast.success(message);
  }

  private reportError(e: unknown): void {
    this.toast.error(e instanceof Error ? e.message : 'Something went wrong.');
  }

  // --- my task: save / submit / send back -------------------------------------

  protected saveDraft(): void {
    const sel = this.selected();
    const data = this.taskData();
    if (!sel || !data) return;
    this.saving.set(true);
    this.dept.saveTask(this.app()!.appl_id, sel.task.task_id, data).subscribe({
      next: (v) => {
        this.saving.set(false);
        this.applyUpdated(v, 'Draft saved.');
      },
      error: (e) => {
        this.saving.set(false);
        this.reportError(e);
      },
    });
  }

  protected submitTask(): void {
    const sel = this.selected();
    const data = this.taskData();
    if (!sel || !data) return;
    if (this.problems().length) {
      this.toast.error(`Complete the form before submitting (${this.problems().length} item(s) pending).`);
      return;
    }
    this.submitting.set(true);
    this.dept.submitTask(this.app()!.appl_id, sel.task.task_id, data).subscribe({
      next: (v) => {
        this.submitting.set(false);
        this.applyUpdated(v, `${sel.task.name} submitted.`);
      },
      error: (e) => {
        this.submitting.set(false);
        this.reportError(e);
      },
    });
  }

  protected canSendBack(): boolean {
    return !!this.selected()?.allowed.send_back;
  }

  protected canRequestDocuments(): boolean {
    return !!this.selected()?.allowed.request_documents;
  }

  protected onDecide(e: { outcome: WorkflowOutcome; input: DecisionInput }): void {
    const sel = this.selected();
    if (!sel) return;
    this.submitting.set(true);
    this.dept.decide(this.app()!.appl_id, sel.task.task_id, e.outcome, e.input).subscribe({
      next: (v) => {
        this.submitting.set(false);
        this.applyUpdated(v, e.outcome === 'inspect' ? 'Inspection ordered.' : 'Decision submitted.');
      },
      error: (err) => {
        this.submitting.set(false);
        this.reportError(err);
      },
    });
  }

  // --- generic modal ------------------------------------------------------------

  protected openModal(kind: ModalKind, row: PendingRow | null = null): void {
    this.modalTask = row;
    this.comments = '';
    this.reassignTo = this.reassignCandidates()[0]?.id ?? null;
    this.requestDocDesc = '';
    this.uploadFile = null;
    this.uploadDesc = '';
    this.smsMessage = '';
    const a = this.app();
    this.newDistrict = a?.district ?? 0;
    this.newStation = null;
    this.licAuth = a?.lic_auth ?? '';
    this.licAddr = a?.lic_addr ?? '';
    this.modal.set(kind);
    if (kind === 'reassign') this.reassignTo = this.reassignCandidates()[0]?.id ?? null;
  }

  protected closeModal(): void {
    this.modal.set(null);
    this.modalTask = null;
  }

  protected onUploadFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      this.toast.error(problem);
      return;
    }
    this.uploadFile = file;
  }

  protected confirmModal(): void {
    const a = this.app();
    if (!a) return;
    const kind = this.modal();
    this.modalBusy.set(true);
    const done = (v: DeptView, msg: string) => {
      this.modalBusy.set(false);
      this.closeModal();
      this.applyUpdated(v, msg);
    };
    const fail = (e: unknown) => {
      this.modalBusy.set(false);
      this.reportError(e);
    };
    switch (kind) {
      case 'sendback': {
        const taskId = this.modalTask?.task.task_id ?? this.selected()?.task.task_id;
        if (!taskId) return;
        this.dept.sendBack(a.appl_id, taskId, this.comments).subscribe({ next: (x) => done(x, 'Sent back to the previous stage.'), error: fail });
        return;
      }
      case 'bypass': {
        const taskId = this.modalTask?.task.task_id;
        if (!taskId) return;
        this.dept.skipTask(a.appl_id, taskId).subscribe({ next: (x) => done(x, 'Officer bypassed.'), error: fail });
        return;
      }
      case 'reassign': {
        const taskId = this.modalTask?.task.task_id;
        if (!taskId || !this.reassignTo) return;
        this.dept.reassignTask(a.appl_id, taskId, Number(this.reassignTo)).subscribe({ next: (x) => done(x, 'Officer changed.'), error: fail });
        return;
      }
      case 'request_doc': {
        this.dept.requestDocuments(a.appl_id, this.requestDocDesc).subscribe({ next: (x) => done(x, 'Document requested from the applicant.'), error: fail });
        return;
      }
      case 'upload_doc': {
        if (!this.uploadFile) {
          this.modalBusy.set(false);
          this.toast.error('Choose a PDF file to upload.');
          return;
        }
        this.dept.uploadDocument(a.appl_id, this.uploadFile, this.uploadDesc).subscribe({ next: (x) => done(x, 'Document uploaded.'), error: fail });
        return;
      }
      case 'sms': {
        this.dept.sendSms(a.appl_id, this.smsMessage).subscribe({ next: (x) => done(x, 'SMS sent.'), error: fail });
        return;
      }
      case 'fire_station': {
        if (!this.newStation) {
          this.modalBusy.set(false);
          this.toast.error('Select the fire station.');
          return;
        }
        this.dept.changeFireStation(a.appl_id, Number(this.newDistrict), Number(this.newStation)).subscribe({ next: (x) => done(x, 'Fire station changed.'), error: fail });
        return;
      }
      case 'lic_auth': {
        this.dept.updateLicensingAuthority(a.appl_id, this.licAuth, this.licAddr).subscribe({ next: (x) => done(x, 'Licensing authority updated.'), error: fail });
        return;
      }
      default:
        this.modalBusy.set(false);
    }
  }

  protected levelName(a: Application): string {
    return delegationLevelName(a.delegation_level);
  }

  protected workflowName(a: Application): string {
    const code = a.workflow?.definition_code;
    return this.cfg()?.workflows.find((w) => w.code === code)?.name ?? code ?? '—';
  }
}
