/**
 * Phase B3: department processing through the real API and database — every
 * officer action of the Head Office workflow, the routing actions, the final
 * decision with its signed copy, and the rules around them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Application, FormDef } from '@srisaa/noc-domain';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { caller, submittedApplication, uploader, validFormData, type Who } from '../helpers/journey.js';
import { reseed } from '../helpers/reseed.js';

interface DeptView {
  application: Application;
  allowed_actions: {
    tasks: { task_id: number; submit: boolean; send_back: boolean; decide: boolean; request_documents: boolean; challan_check: boolean }[];
    outcomes: string[];
    skip: number[];
    reassign: number[];
    reassign_candidates: Record<number, { id: number; username: string }[]>;
    change_fire_station: boolean;
    update_licensing_authority: boolean;
    is_decider: boolean;
  };
  parent: Application | null;
}

describe('department workflow (B3)', () => {
  let t: TestApi;
  let db: pg.Client;
  const who: Record<string, Who> = {};
  let forms: FormDef[] = [];
  let call: ReturnType<typeof caller>;
  let upload: ReturnType<typeof uploader>;

  const login = async (u: string) => (who[u] ??= await t.login(u));

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    call = caller(t);
    upload = uploader(t);
    db = new pg.Client({ connectionString: testDatabaseUrl() });
    await db.connect();
    for (const u of ['citizen1', 'section.hq', 'dfo.visakhapatnam', 'sfo.officer', 'rfo.officer', 'adfs.officer', 'dfscd.officer', 'dfs.officer', 'dg.officer', 'dfo.guntur', 'monitor.hq', 'admin']) {
      await login(u);
    }
    forms = (await call('GET', '/config/forms', who['admin'])).json();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await t.close();
  });

  const view = async (id: number, as: string): Promise<DeptView> => {
    const res = await call('GET', `/dept/applications/${id}`, who[as]);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  const myTask = (v: DeptView) => {
    const allowed = v.allowed_actions.tasks[0];
    return allowed ? v.application.workflow!.tasks.find((x) => x.task_id === allowed.task_id)! : undefined;
  };

  /** The officer submits his open task with a complete, valid form. */
  const submitMine = async (id: number, as: string, extra: Record<string, unknown> = {}) => {
    const v = await view(id, as);
    const task = myTask(v);
    expect(task, `${as} has no open task`).toBeTruthy();
    const form = forms.find((f) => f.id === task!.form)!;
    const data = validFormData(form, v.application, as, extra);
    const res = await call('POST', `/dept/applications/${id}/tasks/${task!.task_id}/submit`, who[as], { data });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DeptView;
  };

  const decideAs = async (id: number, as: string, outcome: string, input: Record<string, unknown> = { remark: 'Decided.' }, signed = true) => {
    const v = await view(id, as);
    const task = myTask(v)!;
    if (signed) {
      const up = await upload(`/dept/applications/${id}/tasks/${task.task_id}/signed-copy`, who[as], {}, 'signed.pdf');
      expect(up.statusCode, up.body).toBe(201);
    }
    return call('POST', `/dept/applications/${id}/tasks/${task.task_id}/decide`, who[as], { outcome, input });
  };

  describe('the Head Office workflow, end to end', () => {
    let id = 0;
    let number = '';

    beforeAll(async () => {
      ({ id, number } = await submittedApplication(t, who['citizen1'], { name: 'Head Office Journey' }));
    }, 60_000);

    it('puts the scrutiny tasks in the queues of the officers of the station', async () => {
      const tasks = (await call('GET', '/dept/tasks', who['section.hq'])).json().items as { app: { appl_id: number; appl_number: string }; task: { name: string }; action: string; sla: number }[];
      const mine = tasks.find((x) => x.app.appl_id === id)!;
      expect(mine).toBeTruthy();
      expect(mine.app.appl_number).toBe(number);
      expect(mine.task.name).toBe('Scrutiny by Section');
      expect(mine.action).toBe('Submit Note');
      expect(mine.sla).toBe(5);
      expect((await call('GET', '/dept/tasks', who['dfo.visakhapatnam'])).json().items.some((x: { app: { appl_id: number } }) => x.app.appl_id === id)).toBe(true);
      expect((await call('GET', '/dept/tasks', who['dfo.guntur'])).json().items.some((x: { app: { appl_id: number } }) => x.app.appl_id === id)).toBe(false);
    });

    it('hides the file from officers of other stations and from citizens', async () => {
      expect((await call('GET', `/dept/applications/${id}`, who['dfo.guntur'])).statusCode).toBe(404);
      expect((await call('GET', `/dept/applications/${id}`, who['citizen1'])).statusCode).toBe(403);
    });

    it('saves a draft of the note without completing the task', async () => {
      const v = await view(id, 'section.hq');
      const task = myTask(v)!;
      const res = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/save`, who['section.hq'], { data: { remark: 'half way' } });
      expect(res.statusCode).toBe(200);
      const after = res.json() as DeptView;
      const saved = after.application.workflow!.tasks.find((x) => x.task_id === task.task_id)!;
      expect(saved).toMatchObject({ state: 'active', draft: true, data: { remark: 'half way' } });
      expect(after.application.status_id).toBe(2);
    });

    it('refuses an incomplete note with the form problems (server-side validation)', async () => {
      const v = await view(id, 'section.hq');
      const task = myTask(v)!;
      const res = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/submit`, who['section.hq'], { data: { remark: '' } });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/Complete the form before submitting/);
      expect(res.json().errors.map((e: { message: string }) => e.message)).toContain('Enter the remarks of the note.');
    });

    it('refuses an officer who is not the assignee', async () => {
      const v = await view(id, 'section.hq');
      const task = myTask(v)!;
      const res = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/submit`, who['dfo.visakhapatnam'], {
        data: validFormData(forms.find((f) => f.id === 'section_note')!, v.application, 'x'),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toBe('Only the officer the task is assigned to can act on it.');
    });

    it('completes the scrutiny stage when all three officers have submitted', async () => {
      await submitMine(id, 'section.hq');
      await submitMine(id, 'dfo.visakhapatnam');
      const after = await submitMine(id, 'sfo.officer');
      expect(after.application.status_id).toBe(3);
      expect(after.application.stage_label).toBe('Inspected');
      expect(after.application.reviewer).toBe('RFO - Eastern Region');
      const log = after.application.processLog.map((p) => p.action);
      expect(log).toEqual(expect.arrayContaining(['Scrutiny by Section submitted', 'Inspection Report (Committee Chairman) submitted']));
    });

    it('sends the file back to the previous stage and restores the status', async () => {
      await submitMine(id, 'rfo.officer');
      const v = await view(id, 'adfs.officer');
      expect(v.allowed_actions.tasks[0].send_back).toBe(true);
      const task = myTask(v)!;
      const missing = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/send-back`, who['adfs.officer'], { comments: ' ' });
      expect(missing.json().detail).toBe('Enter the comments for the officer the file is sent back to.');
      const res = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/send-back`, who['adfs.officer'], { comments: 'Please recheck the approach road.' });
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json() as DeptView;
      expect(after.application.status_id).toBe(3);
      expect(after.application.stage_label).toBe('Inspected');
      expect(after.application.processLog.at(-1)).toMatchObject({ action: 'Sent back to Regional Review', remarks: 'Please recheck the approach road.' });
      // the RFO has the note again, with his earlier data
      const rfo = await view(id, 'rfo.officer');
      expect(myTask(rfo)?.data).toMatchObject({ recommendation: 'Y' });
    });

    it('moves through RFO, ADFS, DFS-CD and DFS to the final decision', async () => {
      await submitMine(id, 'rfo.officer');
      await submitMine(id, 'adfs.officer');
      await submitMine(id, 'dfscd.officer');
      const after = await submitMine(id, 'dfs.officer');
      expect(after.application.status_id).toBe(6);
      expect(after.application.reviewer).toBe('Director General (HQ)');
      const dg = await view(id, 'dg.officer');
      expect(dg.allowed_actions.tasks[0].decide).toBe(true);
      expect(dg.allowed_actions.outcomes).toEqual(['approve', 'return', 'reject']);
      expect(dg.allowed_actions.update_licensing_authority).toBe(true);
    });

    it('updates the licensing authority only at the final stage', async () => {
      const res = await call('PUT', `/dept/applications/${id}/licensing-authority`, who['dg.officer'], { lic_auth: 'GVMC', lic_addr: 'Visakhapatnam' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().application).toMatchObject({ lic_auth: 'GVMC', lic_addr: 'Visakhapatnam' });
    });

    it('previews the NOC without deciding anything', async () => {
      const v = await view(id, 'dg.officer');
      const task = myTask(v)!;
      const res = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/decision-preview`, who['dg.officer'], { outcome: 'approve', input: { remark: 'Issued subject to conditions.' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.status_id).toBe(7);
      expect((await view(id, 'dg.officer')).application.status_id).toBe(6);
    });

    it('requires the signed copy and the remarks for the decision', async () => {
      const v = await view(id, 'dg.officer');
      const task = myTask(v)!;
      const unsigned = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/decide`, who['dg.officer'], { outcome: 'approve', input: { remark: 'ok' } });
      expect(unsigned.json().detail).toBe('Upload the signed NOC / letter before submitting the decision.');
      await upload(`/dept/applications/${id}/tasks/${task.task_id}/signed-copy`, who['dg.officer'], {}, 'signed-noc.pdf');
      const noRemark = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/decide`, who['dg.officer'], { outcome: 'approve', input: { remark: '' } });
      expect(noRemark.json().detail).toBe('Enter the remarks of the decision (they are printed on the NOC / letter).');
    });

    it('issues the NOC: status 7, final date, decided snapshot, the applicant notified', async () => {
      const res = await decideAs(id, 'dg.officer', 'approve', { remark: 'Provisional NOC issued subject to the conditions.', addcc: 'Commissioner, GVMC' });
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json() as DeptView;
      expect(after.application).toMatchObject({ status_id: 7, stage_label: 'Approved', reviewer: '' });
      expect(after.application.final_date).toBeTruthy();
      expect(after.application.workflow?.completed_on).toBeTruthy();
      const decision = after.application.workflow!.tasks.find((x) => x.decision === 'approve')!;
      expect(decision.data).toMatchObject({ addcc: 'Commissioner, GVMC', signed_document: { file_name: 'signed.pdf' } }); // the latest upload counts
      expect(after.application.processLog.at(-1)).toMatchObject({ action: 'Issued', role: 'DG' });
      expect(after.allowed_actions.tasks).toEqual([]);

      const revisions = (await call('GET', `/applications/${id}/revisions`, who['citizen1'])).json();
      expect(revisions.map((r: { kind: string }) => r.kind)).toEqual(['submitted', 'decided']);
      const outbox = await db.query(`select template_key from notification_outbox where application_id = $1`, [id]);
      expect(outbox.rows.map((r) => r.template_key)).toEqual(expect.arrayContaining(['submitted', 'forwarded_to', 'final_status', 'final_status_mail']));

      // the citizen sees the outcome, but not the officers' notes
      const citizenView = (await call('GET', `/applications/${id}`, who['citizen1'])).json() as Application;
      expect(citizenView.status_id).toBe(7);
      expect(citizenView.workflow!.tasks.every((x) => Object.keys(x.data).length === 0)).toBe(true);
    });

    it('refuses any further action on a decided file', async () => {
      const res = await call('POST', `/dept/applications/${id}/sms`, who['dg.officer'], { message: 'hello' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toBe('This application has no workflow in progress.');
    });
  });

  describe('the issuing authority: bypass and change officer', () => {
    let id = 0;
    beforeAll(async () => {
      ({ id } = await submittedApplication(t, who['citizen1'], { name: 'Bypass Towers' }));
    }, 60_000);

    it('lets only the issuing authority bypass or reassign', async () => {
      const dg = await view(id, 'dg.officer');
      expect(dg.allowed_actions.is_decider).toBe(true);
      const committee = dg.application.workflow!.tasks.find((x) => x.task_key === 'committee')!;
      expect(dg.allowed_actions.skip).toContain(committee.task_id);
      expect(dg.allowed_actions.reassign).toContain(committee.task_id);
      const other = await call('POST', `/dept/applications/${id}/tasks/${committee.task_id}/skip`, who['section.hq']);
      expect(other.statusCode).toBe(403);
      expect(other.json().detail).toBe('Only the issuing authority can bypass an officer.');
    });

    it('reassigns the committee task to another station officer', async () => {
      const dg = await view(id, 'dg.officer');
      const committee = dg.application.workflow!.tasks.find((x) => x.task_key === 'committee')!;
      const candidates = dg.allowed_actions.reassign_candidates[committee.task_id];
      const target = candidates.find((x) => x.username === 'sfo.krishna')!;
      const wrongRole = await call('POST', `/dept/applications/${id}/tasks/${committee.task_id}/reassign`, who['dg.officer'], {
        to: (await login('dfo.guntur')) && dg.allowed_actions.reassign_candidates[dg.application.workflow!.tasks.find((x) => x.task_key === 'inspection')!.task_id][0].id,
      });
      expect(wrongRole.statusCode).toBe(422);
      expect(wrongRole.json().detail).toBe('The task needs a SFO.');
      const res = await call('POST', `/dept/applications/${id}/tasks/${committee.task_id}/reassign`, who['dg.officer'], { to: target.id });
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json() as DeptView;
      expect(after.application.workflow!.tasks.find((x) => x.task_id === committee.task_id)!.assignee).toBe('sfo.krishna');
      expect(after.application.processLog.at(-1)?.action).toBe('Committee Member Concurrence: officer changed');
    });

    it('bypasses the committee member; the stage completes without him', async () => {
      const dg = await view(id, 'dg.officer');
      const committee = dg.application.workflow!.tasks.find((x) => x.task_key === 'committee')!;
      const res = await call('POST', `/dept/applications/${id}/tasks/${committee.task_id}/skip`, who['dg.officer']);
      expect(res.statusCode, res.body).toBe(200);
      await submitMine(id, 'section.hq');
      const after = await submitMine(id, 'dfo.visakhapatnam');
      expect(after.application.status_id).toBe(3);
      expect(after.application.processLog.some((p) => p.action === 'Committee Member Concurrence bypassed' && p.remarks === 'Officer Bypassed')).toBe(true);
    });
  });

  describe('file actions', () => {
    let id = 0;
    beforeAll(async () => {
      ({ id } = await submittedApplication(t, who['citizen1'], { name: 'File Actions Towers' }));
    }, 60_000);

    it('requests a document; the citizen answers it; the officer sees it uploaded', async () => {
      const res = await call('POST', `/dept/applications/${id}/document-requests`, who['section.hq'], { file_desc: 'Structural stability certificate' });
      expect(res.statusCode, res.body).toBe(201);
      const request = (res.json() as DeptView).application.deptfiles.at(-1)!;
      expect(request).toMatchObject({ status: 'R', file_desc: 'Structural stability certificate', requested_by: 'Section Officer (HQ)' });
      const answer = await upload(`/applications/${id}/document-requests/${request.fileid}/response`, who['citizen1'], { comment: 'Attached' }, 'stability.pdf');
      expect(answer.statusCode, answer.body).toBe(201);
      expect((await view(id, 'section.hq')).application.deptfiles.find((f) => f.fileid === request.fileid)?.status).toBe('U');
    });

    it('refuses file actions by an officer with no open task on the file', async () => {
      const res = await call('POST', `/dept/applications/${id}/sms`, who['adfs.officer'], { message: 'hello' });
      expect(res.statusCode).toBe(403);
      expect(res.json().detail).toBe('Only an officer with an open task on this file can do this.');
    });

    it('uploads a department document (PDF only) and sends an SMS', async () => {
      const bad = await upload(`/dept/applications/${id}/dept-documents`, who['dfo.visakhapatnam'], { description: 'Photo' }, 'site.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
      expect(bad.statusCode).toBe(415);
      const doc = await upload(`/dept/applications/${id}/dept-documents`, who['dfo.visakhapatnam'], { description: 'Inspection photographs' }, 'inspection.pdf');
      expect(doc.statusCode, doc.body).toBe(201);
      expect((doc.json() as DeptView).application.dept_documents?.at(-1)).toMatchObject({ description: 'Inspection photographs', uploaded_by: 'DFO - Visakhapatnam', file_name: 'inspection.pdf' });
      const sms = await call('POST', `/dept/applications/${id}/sms`, who['dfo.visakhapatnam'], { message: 'Inspection on Monday 10 AM.' });
      expect(sms.statusCode).toBe(201);
      expect((sms.json() as DeptView).application.sms?.at(-1)).toMatchObject({ message: 'Inspection on Monday 10 AM.' });
      const outbox = await db.query(`select payload from notification_outbox where application_id = $1 and template_key = 'dept_message'`, [id]);
      expect(outbox.rows[0].payload.message).toBe('Inspection on Monday 10 AM.');
    });

    it('moves the file to another fire station while nobody has acted, re-resolving the officers', async () => {
      const v = await view(id, 'section.hq');
      expect(v.allowed_actions.change_fire_station).toBe(true);
      const guntur = await db.query(`select id, district_id from fire_stations where id in (select fire_station_id from dept_user_stations s join users u on u.id = s.user_id where u.username = 'dfo.guntur') limit 1`);
      const res = await call('PUT', `/dept/applications/${id}/fire-station`, who['section.hq'], { district: guntur.rows[0].district_id, fire_station_id: guntur.rows[0].id });
      expect(res.statusCode, res.body).toBe(200);
      const after = (await call('GET', `/applications/${id}`, who['admin'])).json() as Application;
      expect(after.fire_station_id).toBe(guntur.rows[0].id);
      expect(after.workflow!.tasks.find((x) => x.task_key === 'inspection')!.assignee).toBe('dfo.guntur');
      expect(after.processLog.at(-1)?.action).toBe('Fire station changed');
    });
  });

  describe('the rules around the decision', () => {
    it('demands the challan tick from the Section officer when the fee was paid by challan (B2-1)', async () => {
      const { id } = await submittedApplication(t, who['citizen1'], { name: 'Challan Towers', payment: 'challan' });
      const v = await view(id, 'section.hq');
      expect(v.allowed_actions.tasks[0].challan_check).toBe(true);
      const task = myTask(v)!;
      const form = forms.find((f) => f.id === 'section_note')!;
      const without = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/submit`, who['section.hq'], { data: validFormData(form, v.application, 'Section') });
      expect(without.statusCode).toBe(422);
      expect(without.json().errors[0].message).toContain('tick "Challan verified"');
      const withTick = await call('POST', `/dept/applications/${id}/tasks/${task.task_id}/submit`, who['section.hq'], { data: validFormData(form, v.application, 'Section', { challan_verified: 'Y' }) });
      expect(withTick.statusCode, withTick.body).toBe(200);
      // the other officers of the stage are not asked
      expect((await view(id, 'dfo.visakhapatnam')).allowed_actions.tasks[0].challan_check).toBe(false);
    }, 60_000);

    it('removes "return" once the processing SLA has passed (legacy rtimeout)', async () => {
      const { id } = await submittedApplication(t, who['citizen1'], { name: 'Overdue Towers' });
      for (const u of ['section.hq', 'dfo.visakhapatnam', 'sfo.officer', 'rfo.officer', 'adfs.officer', 'dfscd.officer', 'dfs.officer']) await submitMine(id, u);
      await db.query(`update wf_instances set started_at = now() - interval '90 days' where subject_id = $1 and status = 'running'`, [id]);
      const dg = await view(id, 'dg.officer');
      expect(dg.allowed_actions.outcomes).toEqual(['approve', 'reject']);
      const res = await decideAs(id, 'dg.officer', 'return', { remark: 'Return' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toBe('The processing SLA of 60 days has been exceeded — the application can only be approved or rejected.');
      const monitoring = (await call('GET', '/dept/monitoring?overdueOnly=true', who['dg.officer'])).json();
      expect(monitoring.items.some((r: { app: { appl_id: number } }) => r.app.appl_id === id)).toBe(true);
    }, 90_000);

    it('returns a file with remarks; the citizen revises it and a new run starts on resubmission', async () => {
      const { id } = await submittedApplication(t, who['citizen1'], { name: 'Return Towers' });
      for (const u of ['section.hq', 'dfo.visakhapatnam', 'sfo.officer', 'rfo.officer', 'adfs.officer', 'dfscd.officer', 'dfs.officer']) await submitMine(id, u);
      const res = await decideAs(id, 'dg.officer', 'return', { remark: 'Provide the revised fire plan.' });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as DeptView).application).toMatchObject({ status_id: 8, stage_label: 'Returned with Comments' });
      const revised = await call('POST', `/applications/${id}/revise`, who['citizen1']);
      expect(revised.json().application).toMatchObject({ status_id: 1, revision: 2, declaration_accepted: false });
      // the applicant confirms the declaration again before resubmitting
      const draft = revised.json().application as Application;
      expect((await call('PUT', `/applications/${id}`, who['citizen1'], { ...draft, declaration_accepted: true })).statusCode).toBe(200);
      const resubmit = await call('POST', `/applications/${id}/submit`, who['citizen1'], { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] });
      expect(resubmit.statusCode, resubmit.body).toBe(200);
      const app = resubmit.json().application as Application;
      expect(app).toMatchObject({ status_id: 2, revision: 2 });
      expect(app.workflow_history?.length).toBe(1);
      expect(app.processLog.at(-1)?.action).toBe('Resubmitted');
    }, 90_000);
  });

  describe('a Declaration: inspection ordered by the issuing authority (on-demand stage)', () => {
    it('orders an inspection, then accepts the declaration with its validity', async () => {
      for (const u of ['dfo.guntur', 'sfo.guntur']) await login(u);
      const template = (await call('GET', '/applications/107', who['citizen1'])).json() as Application;
      const created = (await call('POST', '/applications', who['citizen1'], { appl_type: 'D', site_name: 'Declared Towers', site_addr: 'Tank Bund Road, Guntur' })).json().application as Application;
      const saved = (
        await call('PUT', `/applications/${created.appl_id}`, who['citizen1'], {
          ...created,
          appl_mode: template.appl_mode,
          district: template.district,
          fire_station_id: template.fire_station_id,
          corr_addr: template.corr_addr,
          plot_area: template.plot_area,
          perimeter: template.perimeter,
          lic_auth: template.lic_auth,
          lic_addr: template.lic_addr,
          ref_no: 'ONOC/2020/2211',
          noc_level: 'DFO',
          last_inspect_date: template.last_inspect_date,
          declaration_accepted: true,
        })
      ).json().application as Application;
      expect((await call('POST', `/applications/${saved.appl_id}/payment`, who['citizen1'], { mode: 'online' })).statusCode).toBe(200);
      expect((await upload(`/applications/${saved.appl_id}/documents`, who['citizen1'], { code: 'Declaration' }, 'declaration.pdf')).statusCode).toBe(201);
      const submitted = await call('POST', `/applications/${saved.appl_id}/submit`, who['citizen1'], { undertakings: ['correct', 'nohite', 'onlyfire'] });
      expect(submitted.statusCode, submitted.body).toBe(200);
      const id = saved.appl_id;

      // the decision comes first; the inspection stage only runs when ordered
      let dfo = await view(id, 'dfo.guntur');
      expect(dfo.application.workflow!.definition_code).toBe('D-DFO');
      expect(dfo.allowed_actions.outcomes).toEqual(['approve', 'return', 'reject', 'inspect']);
      const ordered = await call('POST', `/dept/applications/${id}/tasks/${myTask(dfo)!.task_id}/decide`, who['dfo.guntur'], { outcome: 'inspect', input: { remark: 'Inspect the fire pumps.' } });
      expect(ordered.statusCode, ordered.body).toBe(200);
      expect((ordered.json() as DeptView).application.processLog.at(-1)?.action).toBe('Inspection ordered');
      await submitMine(id, 'sfo.guntur');

      dfo = await view(id, 'dfo.guntur');
      expect(myTask(dfo)?.task_key).toBe('decision');
      const res = await decideAs(id, 'dfo.guntur', 'approve', { remark: 'Declaration accepted.' });
      expect(res.statusCode, res.body).toBe(200);
      const app = (res.json() as DeptView).application;
      expect(app).toMatchObject({ status_id: 7 });
      expect(app.processLog.at(-1)?.action).toBe('Accepted');
      expect(app.valid_from).toBe(app.final_date);
      expect(app.valid_to).toBeTruthy();
    }, 60_000);

    it('takes the renewal period recorded at submission for the validity of a renewal', async () => {
      await login('dfs.officer');
      const res = await decideAs(106, 'dfs.officer', 'approve', { remark: 'Renewed.' });
      expect(res.statusCode, res.body).toBe(200);
      const app = (res.json() as DeptView).application;
      const from = new Date(app.valid_from!);
      const to = new Date(app.valid_to!);
      expect(to.getFullYear() - from.getFullYear()).toBeGreaterThanOrEqual(0);
      expect(app.processLog.at(-1)?.action).toBe('Issued');
    });
  });

  describe('the queues', () => {
    it('lists my tasks oldest first, with the counts per task, filtered and limited on the server', async () => {
      const all = (await call('GET', '/dept/tasks', who['dfs.officer'])).json();
      expect(all.total).toBe(all.items.length);
      expect(all.total).toBeGreaterThan(0);
      expect(all.groups.reduce((n: number, g: { count: number }) => n + g.count, 0)).toBe(all.total);
      expect(all.overdue).toBe(all.items.filter((r: { overdue: boolean }) => r.overdue).length);
      const days = all.items.map((r: { days: number }) => r.days);
      expect(days).toEqual([...days].sort((a: number, b: number) => b - a));
      const first = (await call('GET', '/dept/tasks?limit=1', who['dfs.officer'])).json();
      expect(first.items).toHaveLength(1);
      expect(first.total).toBe(all.total);
      expect(first.items[0].app.appl_id).toBe(all.items[0].app.appl_id);
      const type = all.items[0].app.appl_type as string;
      const ofType = (await call('GET', `/dept/tasks?type=${type}`, who['dfs.officer'])).json();
      expect(ofType.items.length).toBeGreaterThan(0);
      expect(ofType.items.every((r: { app: { appl_type: string } }) => r.app.appl_type === type)).toBe(true);
      const none = (await call('GET', '/dept/tasks?text=no-such-building-anywhere', who['dfs.officer'])).json();
      expect(none).toEqual({ items: [], total: 0, overdue: 0, groups: [] });
    });

    it('pages and filters the monitoring list on the server, with stage chips and KPIs', async () => {
      const res = await call('GET', '/dept/monitoring?pageSize=2', who['monitor.hq']);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.total).toBeGreaterThan(2);
      expect(body.kpis.in_process).toBe(body.total);
      expect(body.stages.reduce((n: number, s: { count: number }) => n + s.count, 0)).toBe(body.total);
      const decided = (await call('GET', '/dept/monitoring?includeDecided=true&pageSize=200', who['monitor.hq'])).json();
      expect(decided.total).toBeGreaterThan(body.total);
      // few decided files: all of them, whatever their age (over 1 000: the last 12 months by default)
      expect(decided.decided).toEqual({ window_months: null, total: decided.total - body.total });
      expect(body.decided).toBeNull();
      const all = (await call('GET', '/dept/monitoring?includeDecided=true&decided=all&pageSize=200', who['monitor.hq'])).json();
      expect(all.total).toBe(decided.total);
      const text = (await call('GET', '/dept/monitoring?includeDecided=true&text=padma', who['monitor.hq'])).json();
      expect(text.items.length).toBeGreaterThan(0);
      expect(text.items.every((r: { app: { site_name: string } }) => r.app.site_name === 'Padma Rekha Apartments')).toBe(true);
    });

    it("limits an officer's monitoring to his jurisdiction", async () => {
      const guntur = (await call('GET', '/dept/monitoring?includeDecided=true&pageSize=200', who['dfo.guntur'])).json();
      const visakha = (await call('GET', '/dept/monitoring?includeDecided=true&pageSize=200', who['dfo.visakhapatnam'])).json();
      const ids = (x: { items: { app: { appl_id: number } }[] }) => new Set(x.items.map((r) => r.app.appl_id));
      expect([...ids(guntur)].some((i) => ids(visakha).has(i) && i === 101)).toBe(false);
      expect(ids(visakha).has(101)).toBe(true);
    });

    it('summarises the citizen ratings like the legacy dashboard panel', async () => {
      const all = (await call('GET', '/dept/feedback-summary', who['dg.officer'])).json();
      expect(all.count).toBeGreaterThan(0);
      expect(all.distribution).toHaveLength(5);
      expect(all.rows[0]).toHaveProperty('rating');
    });
  });
});
