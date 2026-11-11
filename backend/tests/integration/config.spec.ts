/**
 * Configuration writes (B3): fees and rules publish new immutable versions that
 * new drafts use at once, while a paid fee stays frozen; workflows are saved as
 * new versions (files in process keep theirs), validated, restored, simulated;
 * the SLA is validated and saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application, WorkflowDefinition } from '@srisaa/noc-domain';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { caller, type Who } from '../helpers/journey.js';
import { reseed } from '../helpers/reseed.js';

describe('configuration', () => {
  let t: TestApi;
  let call: ReturnType<typeof caller>;
  let admin: Who;
  let citizen: Who;

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    call = caller(t);
    admin = await t.login('admin');
    citizen = await t.login('citizen1');
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  describe('fees and rules', () => {
    it('publishes a new fee: new drafts use it, a paid fee stays frozen (Q-57)', async () => {
      // application 101 was paid under the seeded rates
      const paidBefore = (await call('GET', '/applications/101/fee', citizen)).json();
      const feeVersionsBefore = (await call('GET', '/config/rules/noc.fees/versions', admin)).json().items[0].version;
      const fees = (await call('GET', '/config/fees', admin)).json();
      const res = await call('PUT', '/config/fees', admin, { ...fees, rates_per_sqm: { ...fees.rates_per_sqm, P: 12 } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().rates_per_sqm.P).toBe(12);
      const draft = (await call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'New Rate Towers', site_addr: 'Fee Street' })).json();
      const template = (await call('GET', '/applications/101', citizen)).json() as Application;
      const saved = (await call('PUT', `/applications/${draft.application.appl_id}`, citizen, { ...draft.application, blocks: template.blocks, district: template.district, fire_station_id: template.fire_station_id })).json();
      expect(saved.assessment.fee.ratePerSqm).toBe(12);
      const paidAfter = (await call('GET', '/applications/101/fee', citizen)).json();
      expect(paidAfter.fee.total).toBe(paidBefore.fee.total);
      const versions = (await call('GET', '/config/rules/noc.fees/versions', admin)).json().items;
      expect(versions[0]).toMatchObject({ version: feeVersionsBefore + 1, current: true });
    });

    it('refuses an invalid configuration with the problems', async () => {
      const fees = (await call('GET', '/config/fees', admin)).json();
      const res = await call('PUT', '/config/fees', admin, { ...fees, portal_charges: -5 });
      expect(res.statusCode).toBe(422);
      expect(res.json().errors.length).toBeGreaterThan(0);
    });

    it('publishes approval-level and renewal rules', async () => {
      const levels = (await call('GET', '/config/delegation-rules', admin)).json();
      expect((await call('PUT', '/config/delegation-rules', admin, levels)).statusCode).toBe(200);
      const renewal = (await call('GET', '/config/renewal-rules', admin)).json();
      renewal[0].years = 4;
      const res = await call('PUT', '/config/renewal-rules', admin, renewal);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()[0].years).toBe(4);
    });

    it('evaluates a published rule set with its trace (admin "try it")', async () => {
      const res = await call('POST', '/rules/sets/noc.approval_level/evaluate', admin, { facts: { site_type: 'res', site_stype: 'A4', height: 20, is_multiplex: false } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().value).toMatchObject({ level: 'MSB' });
      expect(res.json().versionId).toBeGreaterThan(0);
    });

    it('keeps the rule editing to administrators', async () => {
      const officer = await t.login('dg.officer');
      expect((await call('PUT', '/config/fees', officer, {})).statusCode).toBe(403);
    });
  });

  describe('workflows', () => {
    it('validates a definition without saving it', async () => {
      const defs = (await call('GET', '/config/workflows', admin)).json() as WorkflowDefinition[];
      const def = structuredClone(defs.find((d) => d.code === 'P-DFO')!);
      def.stages.pop();
      const res = await call('POST', '/config/workflows/validate', admin, def);
      expect(res.json().problems.join(' ')).toContain('Final Decision form');
    });

    it('saves a new version; files in process keep the version they started with', async () => {
      const defs = (await call('GET', '/config/workflows', admin)).json() as WorkflowDefinition[];
      const def = structuredClone(defs.find((d) => d.code === 'P-RFO')!);
      const before = def.version;
      expect(def.id).toBeGreaterThan(0);
      def.stages[0].name = 'Station Inspection';
      const res = await call('PUT', '/config/workflows/P-RFO', admin, def);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ code: 'P-RFO', version: before + 1 });
      expect(res.json().stages[0].name).toBe('Station Inspection');
      // application 108 is in process on version 1
      const app = (await call('GET', '/applications/108', admin)).json() as Application;
      expect(app.workflow!.version).toBe(before);
      const usage = (await call('GET', '/config/workflows/usage', admin)).json();
      expect(usage['P-RFO'][String(before)].inProcess).toBeGreaterThan(0);
      const versions = (await call('GET', '/config/workflows/P-RFO/versions', admin)).json().items;
      expect(versions.slice(0, 2).map((v: { version: number }) => v.version)).toEqual([before + 1, before]);
    });

    it('refuses an invalid workflow and a change of type or level', async () => {
      const defs = (await call('GET', '/config/workflows', admin)).json() as WorkflowDefinition[];
      const def = structuredClone(defs.find((d) => d.code === 'P-DFO')!);
      def.stages[0].tasks[0].role_id = 99;
      const bad = await call('PUT', '/config/workflows/P-DFO', admin, def);
      expect(bad.statusCode).toBe(422);
      expect(bad.json().detail).toContain('select the role that performs the task');
      const moved = await call('PUT', '/config/workflows/P-DFO', admin, { ...defs.find((d) => d.code === 'P-DFO')!, level: 'MSB' });
      expect(moved.json().detail).toBe('The application type and level of a workflow cannot be changed.');
    });

    it('restores an earlier version as a new one', async () => {
      const current = ((await call('GET', '/config/workflows', admin)).json() as WorkflowDefinition[]).find((d) => d.code === 'P-RFO')!.version;
      const res = await call('POST', '/config/workflows/P-RFO/restore/1', admin);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ version: current + 1 });
      expect(res.json().stages[0].name).not.toBe('Station Inspection');
      const defaults = (await call('GET', '/config/workflows/defaults', admin)).json() as WorkflowDefinition[];
      expect(defaults).toHaveLength(12);
    });

    it('simulates who would do what at a fire station', async () => {
      const defs = (await call('GET', '/config/workflows', admin)).json() as WorkflowDefinition[];
      const res = await call('POST', '/config/workflows/simulate', admin, { definition: defs.find((d) => d.code === 'P-MSB'), fire_station_id: 44 });
      const tasks = res.json().tasks as { task: string; officers: string[]; warning?: string }[];
      expect(tasks.find((x) => x.task === 'Committee Member Concurrence')?.warning).toContain('No active SFO');
    });
  });

  describe('SLA', () => {
    it('validates and saves the SLA and the escalation settings', async () => {
      const sla = (await call('GET', '/config/sla', admin)).json();
      const bad = structuredClone(sla);
      bad.workflows['P-MSB'].inspection_days = 400;
      expect((await call('PUT', '/config/sla', admin, bad)).statusCode).toBe(422);
      sla.workflows['P-MSB'].processing_days = 45;
      sla.escalation.remind_every_days = 3;
      const res = await call('PUT', '/config/sla', admin, sla);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().workflows['P-MSB'].processing_days).toBe(45);
      expect(res.json().escalation.remind_every_days).toBe(3);
    });
  });
});
