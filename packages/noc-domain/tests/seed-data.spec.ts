/** Guards the seed JSON (backend/seed/data) against drift from the model and the business rules. */
import { fixture } from './fixtures.js';
import type {
  Application,
  ApplicationType,
  BuildType,
  DeptRole,
  District,
  DistrictFireStations,
  Equipment,
  FormDef,
  SlaConfig,
  UserAccount,
  WorkflowDefinition,
} from '../src/models/index.js';
import { currentTasks } from '../src/workflow-view.js';
import { slaProblems, workflowSetProblems } from '../src/workflow-admin.js';

describe('seed data consistency', () => {
  const apps = fixture<Application[]>('assets/data/applications/applications.json');
  const users = fixture<UserAccount[]>('assets/data/auth/users.json');
  const types = fixture<ApplicationType[]>('assets/data/lookups/application-types.json');
  const buildTypes = fixture<BuildType[]>('assets/data/lookups/build-types.json');
  const districts = fixture<District[]>('assets/data/lookups/districts.json');
  const stations = fixture<DistrictFireStations[]>('assets/data/lookups/fire-stations.json');
  const equipments = fixture<Equipment[]>('assets/data/lookups/equipments.json');
  const deptRoles = fixture<DeptRole[]>('assets/data/lookups/dept-roles.json');
  const workflows = fixture<WorkflowDefinition[]>('assets/data/config/workflows.json');
  const forms = fixture<FormDef[]>('assets/data/config/forms.json');
  const sla = fixture<SlaConfig>('assets/data/config/sla.json');

  it('has no trace of the dropped Existing Building (E) application type', () => {
    expect(types.map((t) => t.code)).not.toContain('OE');
    expect(types.flatMap((t) => t.mode.map((m) => m.code))).not.toContain('E');
    expect(apps.some((a) => a.appl_mode === 'E')).toBe(false);
  });

  it('uses integer ids for roles, fire stations and districts, and has no "4Q" station left (N-1)', () => {
    expect(deptRoles.every((r) => Number.isInteger(r.id))).toBe(true);
    expect(stations.every((g) => Number.isInteger(g.id) && g.stations.every((s) => Number.isInteger(s.id)))).toBe(true);
    expect(JSON.stringify(stations)).not.toContain('4Q');
    expect(JSON.stringify(users)).not.toContain('4Q');
    expect(users.every((u) => !('password' in u))).toBe(true);
  });

  it('every application has unique id, a citizen owner, valid district, station and occupancy codes', () => {
    expect(new Set(apps.map((a) => a.appl_id)).size).toBe(apps.length);
    for (const a of apps) {
      expect(users.find((u) => u.username === a.owner)?.portal, `owner of ${a.appl_id}`).toBe('citizen');
      expect(districts.some((d) => d.id === a.district), `district of ${a.appl_id}`).toBe(true);
      const st = stations.find((s) => s.id === a.district)?.stations ?? [];
      expect(st.some((s) => s.id === a.fire_station_id), `fire station of ${a.appl_id}`).toBe(true);
      for (const b of a.blocks) {
        const bt = buildTypes.find((t) => t.code === b.site_type);
        expect(bt, `site_type of ${a.appl_id}/${b.block_id}`).toBeDefined();
        expect(bt!.sub.some((s) => s.code === b.site_stype), `site_stype of ${a.appl_id}/${b.block_id}`).toBe(true);
        for (const item of b.ffe.items) {
          expect(equipments.some((e) => e.id === item.equip_id), `equipment ${item.equip_id} in ${a.appl_id}`).toBe(true);
        }
      }
    }
  });

  it('department users carry a valid role; citizens do not', () => {
    for (const u of users.filter((x) => x.portal === 'dept')) {
      expect(deptRoles.some((r) => r.id === u.role_id), u.username).toBe(true);
      expect(u.all_stations || (u.fire_station_ids ?? []).length > 0, `${u.username} has a fire station`).toBe(true);
    }
    for (const u of users.filter((x) => x.portal !== 'dept')) expect(u.role_id).toBeUndefined();
  });

  it('ships a valid workflow configuration and every submitted application has a consistent run', () => {
    expect(workflowSetProblems(workflows, deptRoles, forms)).toEqual([]);
    expect(slaProblems(sla, workflows)).toEqual([]);
    for (const a of apps) {
      if (a.status_id === 1) {
        expect(a.workflow, `draft ${a.appl_id} has no run`).toBeUndefined();
        continue;
      }
      const run = a.workflow!;
      expect(run, `run of ${a.appl_id}`).toBeDefined();
      expect(run.definition_code).toBe(`${a.appl_type === 'RO' ? 'R' : a.appl_type}-${a.delegation_level}`);
      const cur = currentTasks(run);
      const active = cur.filter((t) => t.state === 'active');
      if ([7, 8, 9].includes(a.status_id)) {
        expect(run.completed_on, `completed run of ${a.appl_id}`).toBeTruthy();
        expect(active).toHaveLength(0);
      } else {
        expect(run.completed_on, `open run of ${a.appl_id}`).toBeFalsy();
        expect(active.length, `active task of ${a.appl_id}`).toBeGreaterThan(0);
        for (const t of active) {
          const u = users.find((x) => x.username === t.assignee);
          expect(u?.role_id, `assignee role of ${a.appl_id}/${t.task_key}`).toBe(t.role_id);
        }
      }
    }
  });
});
