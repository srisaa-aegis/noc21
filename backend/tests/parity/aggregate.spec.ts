/**
 * Parity: what the API serialises out of PostgreSQL must equal the portal's
 * JSON fixtures, field by field, for all 14 seeded applications.
 *
 * Differences are only allowed when they are listed in ALLOWED_DIFFS below,
 * which is the record of every intentional change to the wire shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application } from '@srisaa/noc-domain';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { loadAggregate } from '../../src/repositories/application.repo.js';
import { toApplication } from '../../src/serializers/application.serializer.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { reseed } from '../helpers/reseed.js';
import { redateApplications } from '../../src/db/seed/redate.js';
import { REDATE_STATE } from '../../src/db/seed/seed-demo.js';
import { seedState } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'seed', 'data', 'applications', 'applications.json');
const rawFixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Application[];
/** Filled in beforeAll: the fixtures re-dated exactly as the seeder did. */
let fixtures: Application[] = rawFixtures;

/**
 * Intentional differences between the fixture and the API payload.
 * Anything not listed here must match exactly.
 */
const ALLOWED_DIFFS = {
  added: ['row_version'],
  /** Optional collections the fixture omits when empty; the API always sends them. */
  normalisedEmpty: ['dept_documents', 'sms', 'conditions', 'workflow_history'],
};

function normalise(app: Partial<Application> & Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(app)) as Record<string, unknown>;
  for (const key of ALLOWED_DIFFS.added) delete copy[key];
  // The version number of the workflow definition a run uses depends on how many
  // versions an administrator has published before the database was (re)seeded.
  for (const run of [copy['workflow'], ...((copy['workflow_history'] as unknown[]) ?? [])] as Record<string, unknown>[]) {
    if (run) delete run['version'];
  }
  for (const key of ALLOWED_DIFFS.normalisedEmpty) {
    const v = copy[key];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete copy[key];
  }
  // The fixture keeps empty strings for unset optional dates; the API omits them.
  for (const key of ['valid_from', 'valid_to', 'mcapprove_date', 'last_inspect_date', 'ref_no', 'final_date', 'stage_label', 'noc_level']) {
    if (copy[key] === '' || copy[key] === undefined || copy[key] === null) delete copy[key];
  }
  return copy;
}

describe('application aggregate parity with the portal fixtures', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await reseed();
    handle = createDb(testDatabaseUrl(), 4);
    const [anchor] = await handle.db.select().from(seedState).where(eq(seedState.name, REDATE_STATE));
    if (anchor && anchor.checksum !== 'none') {
      const [y, m, d] = anchor.checksum.split('-').map(Number);
      fixtures = redateApplications(rawFixtures, new Date(y, m - 1, d)).applications;
    }
  });
  afterAll(async () => {
    await handle.close();
  });

  for (const raw of rawFixtures) {
    it(`serialises application ${raw.appl_id} (${raw.appl_type}) exactly`, async () => {
      const fixture = fixtures.find((f) => f.appl_id === raw.appl_id)!;
      const rows = await loadAggregate(handle.db, fixture.appl_id);
      expect(rows, `application ${fixture.appl_id} is missing from the database`).toBeTruthy();
      const served = toApplication(rows!);
      expect(normalise(served as never)).toEqual(normalise(fixture as never));
    });
  }

  it('returns every seeded application', async () => {
    for (const f of fixtures) {
      expect(await loadAggregate(handle.db, f.appl_id)).toBeTruthy();
    }
  });
});
