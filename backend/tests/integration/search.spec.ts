/**
 * The free-text search of every list (B3 performance review): number, site
 * name and address, builder (trigram index), district, owner and the exact id;
 * LIKE wildcards typed by the user are taken literally.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { caller, type Who } from '../helpers/journey.js';
import { reseed } from '../helpers/reseed.js';

describe('application search', () => {
  let t: TestApi;
  let call: ReturnType<typeof caller>;
  let admin: Who;
  const ids = async (query: string, who?: Who) =>
    ((await call('GET', `/applications?scope=all&pageSize=all&${query}`, who ?? admin)).json().items as { appl_id: number }[]).map((r) => r.appl_id).sort();

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    call = caller(t);
    admin = await t.login('admin');
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('finds a substring of the site name, case-insensitively', async () => {
    expect(await ids('text=EKHA apart')).toEqual([101, 102]);
  });

  it('finds the district, the owner and the application number', async () => {
    const guntur = await ids('text=guntur');
    expect(guntur.length).toBeGreaterThan(0);
    expect(await ids('text=citizen2')).toEqual(expect.arrayContaining([109, 112]));
    const number = (await call('GET', '/applications/101', admin)).json().appl_number as string;
    expect(await ids(`text=${number.slice(2, 9)}`)).toContain(101);
    expect(await ids('text=101')).toContain(101);
  });

  it('takes % and _ literally', async () => {
    expect(await ids('text=%25')).toEqual([]);
    expect(await ids('text=_')).toEqual([]);
  });

  it('combines the text with the other filters and counts every match', async () => {
    const res = (await call('GET', '/applications?scope=all&text=a&type=P&pageSize=1', admin)).json();
    expect(res.items).toHaveLength(1);
    expect(res.total).toBeGreaterThan(1);
    expect(res.items[0].appl_type).toBe('P');
  });
});
