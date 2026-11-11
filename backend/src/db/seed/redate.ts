/**
 * Re-dating of the demo applications relative to "today" (decision Q-4).
 *
 * The fixtures were written between 2016 and 2026, so files that are still in
 * process showed thousands of days of pendency. Each chain of related
 * applications (Provisional → Occupancy → Renewal) is shifted by one whole
 * number of days, so every interval inside the chain — and therefore every
 * rule that depends on one (penalty years, validity, SLA) — is preserved:
 *
 *   in process   the workflow started 8 / 18 / 35 / 75 days ago
 *                (the 75-day one is deliberately past the 60-day SLA)
 *   decided      the decision was taken 30 / 90 / 200 / 400 days ago
 *   drafts       last touched 4 / 190 days ago (190 keeps the "stale drafts" preset useful)
 *
 * Application numbers follow their new submission month (`yyyymm` + the same
 * sequence), and every reference to them (`ref_no`) is rewritten. Nothing is
 * ever moved into the future.
 */
import type { Application } from '@srisaa/noc-domain';
import { formatLegacyDate, parseLegacyDate } from '@srisaa/noc-domain';

const DAY = 86_400_000;
const LEGACY_DATE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;

const IN_PROCESS_OFFSETS = [8, 18, 35, 75];
const DECIDED_OFFSETS = [30, 90, 200, 400];
const DRAFT_OFFSETS = [4, 190];

function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY);
}

/** Keys whose dates may legitimately lie in the future (certificate validity). */
const FUTURE_ALLOWED = new Set(['valid_to']);

/** Every activity date anywhere inside a value (including task form data). */
function collectDates(value: unknown, out: Date[] = []): Date[] {
  if (typeof value === 'string' && LEGACY_DATE.test(value)) {
    const d = parseLegacyDate(value);
    if (d) out.push(d);
  } else if (Array.isArray(value)) {
    for (const v of value) collectDates(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!FUTURE_ALLOWED.has(k)) collectDates(v, out);
  }
  return out;
}

function shiftDates<T>(value: T, days: number): T {
  if (typeof value === 'string' && LEGACY_DATE.test(value)) {
    const d = parseLegacyDate(value);
    return (d ? formatLegacyDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => shiftDates(v, days)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftDates(v, days);
    return out as T;
  }
  return value;
}

/** Groups applications connected through parent_id / child_id. */
export function chainsOf(apps: Application[]): Application[][] {
  const byId = new Map(apps.map((a) => [a.appl_id, a]));
  const seen = new Set<number>();
  const chains: Application[][] = [];
  for (const app of [...apps].sort((a, b) => a.appl_id - b.appl_id)) {
    if (seen.has(app.appl_id)) continue;
    const chain: Application[] = [];
    const stack = [app.appl_id];
    while (stack.length) {
      const id = stack.pop() as number;
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      const a = byId.get(id) as Application;
      chain.push(a);
      if (a.parent_id) stack.push(a.parent_id);
      if (a.child_id) stack.push(a.child_id);
      for (const other of apps) if (other.parent_id === id) stack.push(other.appl_id);
    }
    chains.push(chain.sort((a, b) => a.appl_id - b.appl_id));
  }
  return chains;
}

export interface RedateResult {
  applications: Application[];
  /** Old application number → new one. */
  renumbered: Record<string, string>;
  /** Shift applied to each application, in days. */
  shifts: Record<number, number>;
}

export function redateApplications(apps: Application[], today: Date): RedateResult {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const shifts: Record<number, number> = {};
  const counters = { inProcess: 0, decided: 0, draft: 0 };

  for (const chain of chainsOf(apps)) {
    const all = chain.flatMap((a) => collectDates(a));
    if (!all.length) continue;
    const latest = new Date(Math.max(...all.map((d) => d.getTime())));
    const inProcess = chain.find((a) => a.status_id >= 2 && a.status_id <= 6 && a.workflow && !a.workflow.completed_on);
    const decided = chain.filter((a) => a.status_id >= 7).sort((a, b) => b.appl_id - a.appl_id)[0];

    let target: Date;
    let anchor: Date;
    if (inProcess) {
      anchor = parseLegacyDate(inProcess.workflow?.started_on) ?? parseLegacyDate(inProcess.applied_date) ?? latest;
      target = new Date(midnight.getTime() - IN_PROCESS_OFFSETS[counters.inProcess++ % IN_PROCESS_OFFSETS.length] * DAY);
    } else if (decided) {
      anchor = parseLegacyDate(decided.final_date) ?? latest;
      target = new Date(midnight.getTime() - DECIDED_OFFSETS[counters.decided++ % DECIDED_OFFSETS.length] * DAY);
    } else {
      anchor = latest;
      target = new Date(midnight.getTime() - DRAFT_OFFSETS[counters.draft++ % DRAFT_OFFSETS.length] * DAY);
    }
    let shift = dayDiff(target, anchor);
    // never move anything into the future
    const latestShifted = latest.getTime() + shift * DAY;
    if (latestShifted > midnight.getTime()) shift -= Math.ceil((latestShifted - midnight.getTime()) / DAY);
    for (const a of chain) shifts[a.appl_id] = shift;
  }

  const shifted = apps.map((a) => shiftDates(a, shifts[a.appl_id] ?? 0));

  // Renumber from the new submission month, keeping the sequence part.
  const renumbered: Record<string, string> = {};
  const used = new Set<string>();
  for (const a of [...shifted].sort((x, y) => x.appl_id - y.appl_id)) {
    if (!a.appl_number) continue;
    const applied = parseLegacyDate(a.applied_date);
    if (!applied) continue;
    const prefix = `${applied.getFullYear()}${String(applied.getMonth() + 1).padStart(2, '0')}`;
    let seq = Number(a.appl_number.slice(6)) || 1;
    let candidate = `${prefix}${String(seq).padStart(4, '0')}`;
    while (used.has(candidate)) candidate = `${prefix}${String(++seq).padStart(4, '0')}`;
    used.add(candidate);
    renumbered[a.appl_number] = candidate;
  }
  const applications = shifted.map((a) => ({
    ...a,
    appl_number: a.appl_number ? (renumbered[a.appl_number] ?? a.appl_number) : a.appl_number,
    ref_no: a.ref_no && renumbered[a.ref_no] ? renumbered[a.ref_no] : a.ref_no,
  }));
  return { applications, renumbered, shifts };
}
