/**
 * Citizen feedback statistics (legacy Feedback_AvgRating.aspx — average rating over the last N
 * months on the department dashboard — and the Feedback Rating Report).
 */
import { Application, DelegationLevel } from './models/index.js';
import { parseLegacyDate } from './dates.js';

export interface FeedbackRow {
  appl_id: number;
  appl_number: string;
  site_name: string;
  build_name: string;
  delegation_level: DelegationLevel;
  rating: number;
  remarks: string;
  rated_on: string;
}

export interface FeedbackSummary {
  average: number;
  count: number;
  /** Count per star value, index 0 = 1 star. */
  distribution: number[];
  rows: FeedbackRow[];
}

/** Average rating of feedback given in the last `months` months (null = all time), optionally for one approval level. */
export function feedbackSummary(apps: Application[], months: number | null, now: Date = new Date(), level?: DelegationLevel): FeedbackSummary {
  const since = months == null ? null : new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const rows: FeedbackRow[] = apps
    .filter((a) => a.feedback && a.feedback.rating >= 1)
    .filter((a) => !level || a.delegation_level === level)
    .filter((a) => {
      if (!since) return true;
      const d = parseLegacyDate(a.feedback!.rated_on);
      return !!d && d >= since && d <= now;
    })
    .map((a) => ({
      appl_id: a.appl_id,
      appl_number: a.appl_number,
      site_name: a.site_name,
      build_name: a.build_name,
      delegation_level: a.delegation_level,
      rating: a.feedback!.rating,
      remarks: a.feedback!.remarks,
      rated_on: a.feedback!.rated_on,
    }))
    .sort((x, y) => (parseLegacyDate(y.rated_on)?.getTime() ?? 0) - (parseLegacyDate(x.rated_on)?.getTime() ?? 0));
  const distribution = [1, 2, 3, 4, 5].map((s) => rows.filter((r) => r.rating === s).length);
  const average = rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 100) / 100 : 0;
  return { average, count: rows.length, distribution, rows };
}
