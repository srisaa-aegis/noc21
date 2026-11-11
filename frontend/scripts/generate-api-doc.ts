/**
 * Prints the API traceability matrix (docs/03-api-catalog.md §2) from core/api/api-endpoints.ts:
 * every operation of the portal with its REST route and the legacy endpoint it replaces.
 *   npx tsx scripts/generate-api-doc.ts > /tmp/matrix.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ENDPOINTS, type ApiEndpoint } from '../src/app/core/api/api-endpoints';

const src = readFileSync(join(__dirname, '..', 'src', 'app', 'core', 'api', 'api-endpoints.ts'), 'utf8');
const sections: { title: string; ids: string[] }[] = [];
for (const line of src.split('\n')) {
  // section comments look like "  // ── Department ─────…"
  const h = /^ {2}\/\/ ── (.+?) ─*$/.exec(line);
  if (h) sections.push({ title: h[1].trim(), ids: [] });
  const e = /^ {2}([a-zA-Z0-9]+): endpoint\(/.exec(line);
  if (e) {
    if (!sections.length) sections.push({ title: 'Other', ids: [] });
    sections[sections.length - 1].ids.push(e[1]);
  }
}
const out: string[] = [];
const cell = (t: string) => t.replace(/\|/g, '\\|');
for (const s of sections) {
  out.push(`### ${s.title}`, '', '| Catalog id | Method | Route (under `/api/v1`) | Legacy endpoint | Purpose |', '|---|---|---|---|---|');
  for (const id of s.ids) {
    const e = (API_ENDPOINTS as Record<string, ApiEndpoint>)[id];
    out.push(`| \`${id}\` | ${e.method} | \`${e.path}\` | \`${cell(e.legacy)}\` | ${cell(e.description)} |`);
  }
  out.push('');
}
console.log(out.join('\n'));
console.error(`${Object.keys(API_ENDPOINTS).length} endpoints in ${sections.length} sections`);
