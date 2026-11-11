/** Session lifetimes (B2-5, B2-6): sliding idle windows capped by an absolute limit. */
import { describe, expect, it } from 'vitest';
import { refreshExpiry } from '../../src/services/auth.service.js';

const H = 3_600_000;
const start = new Date('2026-01-05T08:00:00Z');

describe('refreshExpiry', () => {
  it('gives officers and admins 8 idle hours, never past 12 hours from the first sign-in', () => {
    for (const portal of ['dept', 'admin']) {
      expect(refreshExpiry(portal, start, start.getTime()).getTime() - start.getTime()).toBe(8 * H);
      // active at 10:00 → idle window until 18:00, but the day ends at 20:00 at the latest
      expect(refreshExpiry(portal, start, start.getTime() + 2 * H).getTime() - start.getTime()).toBe(10 * H);
      expect(refreshExpiry(portal, start, start.getTime() + 9 * H).getTime() - start.getTime()).toBe(12 * H);
    }
  });

  it('gives citizens one idle day, within the 30-day absolute lifetime', () => {
    expect(refreshExpiry('citizen', start, start.getTime()).getTime() - start.getTime()).toBe(24 * H);
    const late = start.getTime() + 29.5 * 24 * H;
    expect(refreshExpiry('citizen', start, late).getTime() - start.getTime()).toBe(30 * 24 * H);
  });
});
