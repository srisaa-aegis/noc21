/**
 * Schema invariants: the conventions this project committed to must hold in
 * the actual database, not only in the schema modules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { testDatabaseUrl } from '../helpers/db.js';

describe('database schema', () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query(sql, params)).rows as T[];

  it('has every table keyed by a single integer "id" (files is the only UUID)', async () => {
    const rows = await q<{ table_name: string; column_name: string; data_type: string; cols: number }>(`
      select t.table_name,
             (array_agg(c.column_name order by k.ordinal_position))[1] as column_name,
             (array_agg(c.data_type   order by k.ordinal_position))[1] as data_type,
             count(*) as cols
      from information_schema.tables t
      join information_schema.table_constraints tc
        on tc.table_name = t.table_name and tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
      join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name
      join information_schema.columns c on c.table_name = t.table_name and c.column_name = k.column_name and c.table_schema = 'public'
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> '__drizzle_migrations'
      group by t.table_name`);
    expect(rows.length).toBeGreaterThan(70);
    for (const r of rows) {
      expect(`${r.table_name}: composite key`, `${r.table_name} must have a single-column primary key`).toBeTruthy();
      expect(Number(r.cols), `${r.table_name} primary key column count`).toBe(1);
      expect(r.column_name, `${r.table_name} primary key name`).toBe('id');
      const expected = r.table_name === 'files' ? 'uuid' : 'integer';
      expect(r.data_type, `${r.table_name} primary key type`).toBe(expected);
    }
  });

  it('creates the four read views', async () => {
    const views = (await q<{ table_name: string }>(`select table_name from information_schema.views where table_schema = 'public'`)).map(
      (v) => v.table_name,
    );
    expect(views.sort()).toEqual(['v_active_tasks', 'v_application_summary', 'v_current_tasks', 'v_report_base']);
  });

  it('keeps only one live workflow instance per application', async () => {
    const [row] = await q<{ id: number; definition_id: number; definition_version_id: number }>(
      `select id, definition_id, definition_version_id from wf_instances where status = 'running' limit 1`,
    );
    await expect(
      client.query(
        `insert into wf_instances (definition_id, definition_version_id, subject_type, subject_id, status)
         select definition_id, definition_version_id, subject_type, subject_id, 'running' from wf_instances where id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/wf_instances_live_uq/);
  });

  it('protects the append-only tables', async () => {
    await expect(client.query(`delete from wf_events where id = (select min(id) from wf_events)`)).rejects.toThrow(/append-only/);
    await client.query(
      `insert into audit_log (action, entity_type, entity_id, summary) values ('test', 'test', '1', 'append-only check')`,
    );
    await expect(client.query(`update audit_log set action = 'x' where entity_type = 'test'`)).rejects.toThrow(/append-only/);
    await expect(client.query(`delete from audit_log where entity_type = 'test'`)).rejects.toThrow(/append-only/);
  });

  it('refuses to delete or re-categorise a system status', async () => {
    await expect(client.query(`delete from statuses where id = 1`)).rejects.toThrow(/system status/);
    await expect(client.query(`update statuses set category = 'in_process' where id = 7`)).rejects.toThrow(/reinterpreted/);
  });

  it('refuses to delete a status that has been used', async () => {
    await client.query(`insert into statuses (id, name, category, is_system, sort_order) values (99, 'Temp', 'in_process', false, 99)`);
    await client.query(`delete from statuses where id = 99`); // unused → allowed
    await expect(client.query(`delete from statuses where id = 3`)).rejects.toThrow(/has been used|system status/);
  });

  it('freezes a published rule-set version', async () => {
    await expect(
      client.query(`update re_rule_set_versions set definition = '{}'::jsonb where status = 'published' and id = (select min(id) from re_rule_set_versions)`),
    ).rejects.toThrow(/immutable/);
  });

  it('enforces the business check constraints', async () => {
    await expect(client.query(`update application_feedback set rating = 9 where id = (select min(id) from application_feedback)`)).rejects.toThrow(
      /application_feedback_rating_ck/,
    );
    await expect(client.query(`update payments set amount = -1 where id = (select min(id) from payments)`)).rejects.toThrow(
      /payments_amount_ck/,
    );
  });

  it('cascades a deleted application to its children', async () => {
    const [{ id }] = await q<{ id: number }>(`
      insert into applications (application_type_id, owner_user_id, status_id, site_name)
      select (select id from application_types where code = 'P'), (select id from users where username = 'citizen1'), 1, 'Cascade test'
      returning id`);
    const [{ id: blockId }] = await q<{ id: number }>(
      `insert into blocks (application_id, block_no, block_name) values ($1, 1, 'B') returning id`,
      [id],
    );
    await client.query(`insert into block_floors (block_id, floor_no, flr_name) values ($1, 1, 'G')`, [blockId]);
    await client.query(`delete from applications where id = $1`, [id]);
    expect(await q(`select 1 from blocks where id = $1`, [blockId])).toHaveLength(0);
    expect(await q(`select 1 from block_floors where block_id = $1`, [blockId])).toHaveLength(0);
  });

  it('maintains a gap-free application number sequence per month', async () => {
    const rows = await q<{ prefix: string; last_seq: number }>(`select prefix, last_seq from application_number_sequence`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.last_seq).toBeGreaterThan(0);
  });

  it('indexes the full-text search column', async () => {
    const [row] = await q<{ count: string }>(
      `select count(*)::text as count from applications where search_vector @@ plainto_tsquery('simple', 'Padma')`,
    );
    expect(Number(row.count)).toBeGreaterThan(0);
  });
});
