import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daysSince, parseLegacyDate, type Application } from '@srisaa/noc-domain';
import { chainsOf, redateApplications } from '../../src/db/seed/redate.js';

const apps = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', '..', 'seed', 'data', 'applications', 'applications.json'), 'utf8'),
) as Application[];
const today = new Date(2026, 10, 10);
const { applications, renumbered, shifts } = redateApplications(apps, today);
const byId = new Map(applications.map((a) => [a.appl_id, a]));

/** Activity dates (certificate `valid_to` may legitimately be in the future). */
function allDates(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allDates(v, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => k !== 'valid_to' && allDates(v, out));
  return out;
}

describe('demo data re-dating', () => {
  it('groups related applications into chains', () => {
    const chain = chainsOf(apps).find((c) => c.some((a) => a.appl_id === 101))!;
    expect(chain.map((a) => a.appl_id)).toEqual([101, 102]);
  });

  it('shifts every application of a chain by the same number of days', () => {
    for (const chain of chainsOf(apps)) {
      expect(new Set(chain.map((a) => shifts[a.appl_id])).size).toBe(1);
    }
  });

  it('never puts a date in the future', () => {
    for (const a of applications) {
      for (const d of allDates(a)) expect(parseLegacyDate(d)!.getTime(), `${a.appl_id} ${d}`).toBeLessThanOrEqual(today.getTime());
    }
  });

  it('starts every file in process recently, with one deliberately past its SLA', () => {
    const running = applications.filter((a) => a.workflow && !a.workflow.completed_on && a.status_id > 1);
    const days = running.map((a) => daysSince(a.workflow!.started_on, today)!);
    expect(Math.max(...days)).toBeLessThanOrEqual(75);
    expect(days.some((d) => d > 60)).toBe(true);
    expect(days.filter((d) => d <= 35).length).toBeGreaterThanOrEqual(running.length - 1);
  });

  it('makes the latest decision of every chain recent (earlier links keep their real gap)', () => {
    for (const chain of chainsOf(applications)) {
      const decided = chain.filter((a) => a.status_id >= 7 && a.final_date);
      if (!decided.length || chain.some((a) => a.status_id >= 2 && a.status_id <= 6)) continue;
      const newest = Math.min(...decided.map((a) => daysSince(a.final_date, today)!));
      expect(newest, chain.map((a) => a.appl_id).join('→')).toBeLessThanOrEqual(400);
    }
  });

  it('keeps one draft older than 180 days for the stale-drafts preset', () => {
    const drafts = applications.filter((a) => a.status_id === 1);
    expect(drafts.some((a) => (daysSince(a.last_modified, today) ?? 0) >= 180)).toBe(true);
  });

  it('preserves the intervals inside an application (validity, penalty years, durations)', () => {
    for (const original of apps) {
      const moved = byId.get(original.appl_id)!;
      if (original.valid_from && original.valid_to) {
        const before = parseLegacyDate(original.valid_to)!.getTime() - parseLegacyDate(original.valid_from)!.getTime();
        const after = parseLegacyDate(moved.valid_to)!.getTime() - parseLegacyDate(moved.valid_from)!.getTime();
        expect(Math.abs(after - before)).toBeLessThan(2 * 86_400_000); // DST / month-length tolerance
      }
    }
  });

  it('renumbers from the new submission month and rewrites the references', () => {
    expect(Object.keys(renumbered).length).toBeGreaterThan(5);
    for (const a of applications.filter((x) => x.appl_number)) {
      const applied = parseLegacyDate(a.applied_date)!;
      expect(a.appl_number.slice(0, 6)).toBe(`${applied.getFullYear()}${String(applied.getMonth() + 1).padStart(2, '0')}`);
    }
    expect(new Set(applications.filter((a) => a.appl_number).map((a) => a.appl_number)).size).toBe(
      applications.filter((a) => a.appl_number).length,
    );
    for (const a of applications.filter((x) => x.ref_no)) {
      const original = apps.find((o) => o.appl_id === a.appl_id)!;
      if (renumbered[original.ref_no!]) expect(a.ref_no).toBe(renumbered[original.ref_no!]);
    }
  });

  it('does not change anything but dates and numbers', () => {
    const strip = (a: Application) => JSON.stringify({ ...a, appl_number: '', ref_no: '' }).replace(/\d{1,2}-[A-Za-z]{3}-\d{4}/g, 'D');
    for (const original of apps) expect(strip(byId.get(original.appl_id)!)).toBe(strip(original));
  });
});
