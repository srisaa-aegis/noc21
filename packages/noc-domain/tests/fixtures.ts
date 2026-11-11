/**
 * Loads the seed JSON (backend/seed/data — the single source of the demo data,
 * also used by the frontend tests). Paths keep the historical `assets/data/`
 * prefix the ported tests use.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'backend', 'seed', 'data');

export function fixture<T>(asset: string): T {
  return JSON.parse(readFileSync(join(ROOT, asset.replace(/^assets\/data\//, '')), 'utf8')) as T;
}
