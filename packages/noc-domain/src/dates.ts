/**
 * The legacy system exchanges dates as "dd-Mon-yyyy" strings (e.g. "01-Aug-2016").
 * The fixtures keep that format; these helpers convert at the edges.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatLegacyDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

export function parseLegacyDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2].toLowerCase());
  if (month < 0) {
    return null;
  }
  return new Date(Number(match[3]), month, Number(match[1]));
}

/** Whole days between a legacy date string and `now` (null if unparseable). */
export function daysSince(value: string | null | undefined, now: Date = new Date()): number | null {
  const date = parseLegacyDate(value);
  if (!date) {
    return null;
  }
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

/** Converts "yyyy-mm-dd" (from <input type="date">) to the legacy format. */
export function isoToLegacy(iso: string): string {
  if (!iso) {
    return '';
  }
  const [y, m, d] = iso.split('-').map(Number);
  return formatLegacyDate(new Date(y, m - 1, d));
}

/** Converts a legacy date to "yyyy-mm-dd" for <input type="date">. */
export function legacyToIso(value: string | null | undefined): string {
  const date = parseLegacyDate(value);
  if (!date) {
    return '';
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
