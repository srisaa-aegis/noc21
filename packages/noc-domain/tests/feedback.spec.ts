import { fixture } from './fixtures.js';
import { Application } from '../src/models/index.js';
import { feedbackSummary } from '../src/feedback.js';

const apps = fixture<Application[]>('assets/data/applications/applications.json');

describe('feedback statistics (legacy Feedback_AvgRating)', () => {
  it('averages all ratings overall, newest first', () => {
    const s = feedbackSummary(apps, null);
    expect(s.count).toBe(3); // 101 (4★), 103 (2★), 114 (5★)
    expect(s.average).toBe(3.67);
    expect(s.distribution).toEqual([0, 1, 0, 1, 1]);
    expect(s.rows.map((r) => r.appl_id)).toEqual([114, 101, 103]);
  });

  it('limits to the last N months', () => {
    expect(feedbackSummary(apps, 6, new Date(2022, 9, 1)).rows.map((r) => r.appl_id)).toEqual([114]);
    expect(feedbackSummary(apps, 1, new Date(2026, 0, 1)).count).toBe(0);
    expect(feedbackSummary(apps, 1, new Date(2026, 0, 1)).average).toBe(0);
  });

  it('filters by approval level', () => {
    expect(feedbackSummary(apps, null, new Date(), 'RFO').rows.map((r) => r.appl_id)).toEqual([114]);
  });
});
