import { fixture } from './fixtures.js';
import { Application, FormDef, SlaConfig, UserAccount } from '../src/models/index.js';
import { dueEscalations, escalationEntry, overdueItems } from '../src/escalations.js';

describe('escalations (SLA based)', () => {
  const apps = fixture<Application[]>('assets/data/applications/applications.json');
  const users = fixture<UserAccount[]>('assets/data/auth/users.json');
  const forms = fixture<FormDef[]>('assets/data/config/forms.json');
  const sla = fixture<SlaConfig>('assets/data/config/sla.json');
  const now = new Date(2026, 10, 7);

  it('finds the tasks past their step / inspection SLA and the files past the processing SLA', () => {
    const items = overdueItems(apps, sla, forms, users, now);
    const keys = items.map((n) => `${n.appl_id}/${n.kind}/${n.task}`).sort();
    expect(keys).toEqual([
      '102/inspection/Committee Member Concurrence',
      '102/inspection/Inspection Report (Committee Chairman)',
      '102/processing/Whole processing',
      '106/processing/Whole processing',
      '106/step/Final Decision',
      '108/processing/Whole processing',
      '108/step/DFO Note',
      '109/processing/Whole processing',
      '109/step/DFS-CD Note',
    ]);
    const insp = items.find((n) => n.appl_id === 102 && n.task_id === 2)!;
    expect(insp.sla_days).toBe(15);
    expect(insp.officer_names).toEqual(['DFO - Visakhapatnam']);
    expect(insp.approver_name).toBe('Director General (HQ)');
    const proc = items.find((n) => n.appl_id === 102 && n.kind === 'processing')!;
    expect(proc.officers.sort()).toEqual(['dfo.visakhapatnam', 'sfo.officer']);
    expect(proc.sla_days).toBe(60);
  });

  it('notifies the officer, the issuing authority or both, per configuration', () => {
    const only = (notify_officer: boolean, notify_approver: boolean) =>
      overdueItems(apps, { ...sla, escalation: { ...sla.escalation, notify_officer, notify_approver } }, forms, users, now).find((n) => n.appl_id === 109 && n.kind === 'step')!.recipients;
    expect(only(true, true).sort()).toEqual(['dfscd.officer', 'dg.officer']);
    expect(only(true, false)).toEqual(['dfscd.officer']);
    expect(only(false, true)).toEqual(['dg.officer']);
  });

  it('repeats a reminder for the same item only after the reminder interval', () => {
    const items = overdueItems(apps, sla, forms, users, now);
    const sent = escalationEntry(items, new Date(2026, 10, 4));
    expect(sent.applications).toBe(4);
    expect(dueEscalations(items, [sent], sla, now)).toEqual([]); // 3 days ago, interval 7
    expect(dueEscalations(items, [sent], sla, new Date(2026, 10, 12)).length).toBe(items.length);
    expect(dueEscalations(items, [], sla, now).length).toBe(items.length);
  });

  it('nothing is overdue for a file within every SLA (110)', () => {
    expect(overdueItems(apps.filter((a) => a.appl_id === 110), sla, forms, users, now)).toEqual([]);
  });
});
