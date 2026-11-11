/**
 * Date handling at the edges.
 *
 * The database stores `date` / `timestamptz`; the API speaks the legacy
 * "dd-Mon-yyyy" strings while API_DATE_FORMAT=legacy, and ISO-8601 otherwise.
 * Business dates are interpreted in APP_TIMEZONE.
 */
import { formatLegacyDate, parseLegacyDate } from '@srisaa/noc-domain';
import { config } from '../config/env.js';

export { formatLegacyDate, parseLegacyDate };

/** "01-Aug-2016" | "2016-08-01" | Date | null → "yyyy-mm-dd" for a `date` column. */
export function toDateColumn(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return isoDate(value);
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = parseLegacyDate(trimmed);
  return parsed ? isoDate(parsed) : null;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A `date` column value → the format the API currently speaks. */
export function fromDateColumn(value: string | Date | null | undefined): string {
  if (!value) return '';
  const iso = value instanceof Date ? isoDate(value) : String(value).slice(0, 10);
  if (config().API_DATE_FORMAT === 'iso') return iso;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return formatLegacyDate(new Date(y, m - 1, d));
}

/** A timestamptz → the API's date representation (business date, no time). */
export function timestampToApiDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return fromDateColumn(businessDate(d));
}

/** One formatter per time zone: creating an Intl.DateTimeFormat is costly (≈0.1 ms), formatting is not. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The business (APP_TIMEZONE) calendar date of an instant, as "yyyy-mm-dd". */
export function businessDate(instant: Date = new Date()): string {
  const timeZone = config().APP_TIMEZONE;
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, fmt);
  }
  return fmt.format(instant);
}

/** The business date as a Date at local midnight, for the domain functions. */
export function businessToday(instant: Date = new Date()): Date {
  const [y, m, d] = businessDate(instant).split('-').map(Number);
  return new Date(y, m - 1, d);
}
