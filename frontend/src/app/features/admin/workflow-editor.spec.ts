import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { WorkflowEditor } from './workflow-editor';

describe('WorkflowEditor (admin)', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('admin', 'admin');
    await TestBed.configureTestingModule({ imports: [WorkflowEditor], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function open(id: string) {
    const fixture = TestBed.createComponent(WorkflowEditor);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const saved = (code: string) => TestBed.inject(FakeApi).workflows.find((w) => w.code === code)!;

  it('adds a DFO note stage to the District Provisional workflow, validates it live and saves version 2', async () => {
    const fixture = await open('P-DFO');
    const c = fixture.componentInstance;
    expect(c['problems']()).toEqual([]);
    expect(c['dirty']()).toBe(false);
    c['addStage']();
    fixture.detectChanges();
    const d = c['draft']()!;
    expect(d.stages.map((s) => s.name)).toEqual(['Inspection', 'New stage', 'Final Decision']);
    expect(c['problems']().join(' ')).toContain('select the role');
    expect((fixture.nativeElement as HTMLElement).querySelector('.problems')?.textContent).toContain('select a form');

    const stage = d.stages[1];
    Object.assign(stage, { name: 'DFO Review', stage_label: 'Reviewed by DFO', citizen_status: 6 });
    Object.assign(stage.tasks[0], { name: 'DFO Note', role_id: 6, form: 'dfo_note', action_label: 'Review' });
    d.stages[0].citizen_status = 3;
    c['touch']();
    expect(c['problems']()).toEqual([]);
    expect(c['dirty']()).toBe(true);
    // simulator: Srikakulam fire station → SFO / DFO of Srikakulam
    c['pickDistrict'](1);
    expect(c['simulation']().map((r) => r.officers[0])).toEqual(['SFO - Srikakulam', 'DFO - Srikakulam', 'DFO - Srikakulam']);

    c['save']();
    await fixture.whenStable();
    fixture.detectChanges();
    const w = saved('P-DFO');
    expect(TestBed.inject(FakeApi).calls('PUT', /^\/config\/workflows\/P-DFO$/)).toHaveLength(1);
    expect(w.version).toBe(2);
    expect(w.stages.map((s) => s.key)).toEqual(['inspection', 'stage', 'decision']);
    expect(c['draft']()!.version).toBe(2);
    expect(c['dirty']()).toBe(false);
  });

  it('rejects a final decision used before the last stage and a stage before the decision not at status 6', async () => {
    const fixture = await open('P-RFO');
    const c = fixture.componentInstance;
    const d = c['draft']()!;
    d.stages[1].citizen_status = 5;
    d.stages[0].tasks[0].form = 'final_decision';
    c['touch']();
    const p = c['problems']().join(' ');
    expect(p).toContain('must set status 6');
    expect(p).toContain('only be used in the last stage');
  });

  it('moves stages (never past the final decision), removes one after confirmation and discards changes', async () => {
    const fixture = await open('P-MSB');
    const c = fixture.componentInstance;
    vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    const names = () => c['draft']()!.stages.map((s) => s.key);
    c['moveStage'](1, 1);
    expect(names()).toEqual(['scrutiny', 'adfs', 'rfo', 'dfscd', 'dfs', 'decision']);
    c['moveStage'](4, 1); // dfs cannot move below the decision
    expect(names().at(-1)).toBe('decision');
    await c['removeStage'](4);
    expect(names()).toEqual(['scrutiny', 'adfs', 'rfo', 'dfscd', 'decision']);
    c['discard']();
    expect(names()).toEqual(['scrutiny', 'rfo', 'adfs', 'dfscd', 'dfs', 'decision']);
  });

  it('adds / removes parallel tasks, marks a stage "only when ordered" and wires the inspect outcome', async () => {
    const fixture = await open('D-DFO');
    const c = fixture.componentInstance;
    const d = c['draft']()!;
    const final = d.stages[1].tasks[0];
    expect(c['hasOutcome'](final, 'inspect')).toBe(true);
    c['toggleOutcome'](final, 'inspect', false);
    expect(final.decision!.inspect_stage).toBeUndefined();
    c['toggleOutcome'](final, 'inspect', true);
    expect(final.decision!.inspect_stage).toBe('inspection');
    c['addTask'](d.stages[0]);
    expect(d.stages[0].tasks.length).toBe(2);
    c['onDemandChanged'](d.stages[0], d.stages[0].tasks[1], true);
    expect(d.stages[0].tasks.every((t) => t.on_demand)).toBe(true);
    c['removeTask'](d.stages[0], 1);
    expect(d.stages[0].tasks.length).toBe(1);
  });

  it('restores the shipped workflow and asks before leaving with unsaved changes', async () => {
    const fixture = await open('P-DFO');
    const c = fixture.componentInstance;
    const dialog = vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    expect(await c.canLeave()).toBe(true);
    expect(dialog).not.toHaveBeenCalled();
    c['addStage']();
    await c['restoreDefault']();
    expect(c['draft']()!.stages.length).toBe(2);
    c['addStage']();
    dialog.mockResolvedValue(false);
    expect(await c.canLeave()).toBe(false);
  });

  it('shows the applications running on each version', async () => {
    const fixture = await open('O-RFO');
    expect(fixture.componentInstance['usage']()).toEqual([{ version: 1, total: 2, inProcess: 0 }]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('2 application(s), 0 in process');
  });
});
