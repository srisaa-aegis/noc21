/**
 * npm run openapi — writes the OpenAPI 3.1 document of the API to
 * docs/backend/openapi.json (the same document the API serves at /docs/json).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/env.js';

const app = await buildApp({ logger: false, cfg: { ...config(), ENABLE_DOCS: true, ENABLE_SCHEDULER: false } });
await app.ready();
const doc = (await app.inject({ method: 'GET', url: '/docs/json' })).json() as { paths: Record<string, unknown> };
const file = resolve(config().repoRoot, 'docs', 'backend', 'openapi.json');
writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
console.log(`  \u2713 ${Object.keys(doc.paths).length} paths written to ${file}`);
await app.close();
