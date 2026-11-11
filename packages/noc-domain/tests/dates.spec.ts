import { daysSince, formatLegacyDate, isoToLegacy, legacyToIso, parseLegacyDate } from '../src/dates.js';

describe('legacy date helpers', () => {
  it('formats and parses dd-Mon-yyyy', () => {
    expect(formatLegacyDate(new Date(2016, 7, 1))).toBe('01-Aug-2016');
    expect(parseLegacyDate('01-Aug-2016')?.getMonth()).toBe(7);
    expect(parseLegacyDate('not a date')).toBeNull();
    expect(parseLegacyDate('')).toBeNull();
  });

  it('converts between ISO (date input) and legacy formats', () => {
    expect(isoToLegacy('2024-01-15')).toBe('15-Jan-2024');
    expect(legacyToIso('15-Jan-2024')).toBe('2024-01-15');
    expect(isoToLegacy('')).toBe('');
  });

  it('computes days since a legacy date', () => {
    expect(daysSince('01-Jan-2024', new Date(2024, 0, 31))).toBe(30);
    expect(daysSince('', new Date())).toBeNull();
  });
});
