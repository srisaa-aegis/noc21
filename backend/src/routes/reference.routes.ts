/**
 * Reference data, rule definitions and configuration — all served from the
 * in-process cache (docs/backend/55-caching.md).
 *
 *   GET /meta/versions            tiny version manifest
 *   GET /bundles/:bundle          ETag-validated
 *   GET /bundles/:bundle/v/:n     immutable, content-addressed
 *   GET /bootstrap                everything a cold client needs
 *   GET /lookups/*  /rules/*  /config/*   the 79-entry catalogue surface
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PUBLIC_BUNDLES, type BundleName, type ReferenceBundle, type RulesBundle, type ContentBundle, type WorkflowBundle } from '../cache/bundles.js';
import { forbidden, notFound } from '../errors/app-error.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE_IMMUTABLE = 'private, max-age=31536000, immutable';

function sendBundle(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, name: BundleName, immutable: boolean) {
  const bundle = app.ctx.cache.get(name);
  const isPublic = PUBLIC_BUNDLES.includes(name);
  void reply.header('etag', bundle.etag);
  void reply.header('vary', isPublic ? 'Accept-Encoding' : 'Accept-Encoding, Authorization');
  void reply.header('cache-control', immutable ? (isPublic ? IMMUTABLE : PRIVATE_IMMUTABLE) : isPublic ? 'no-cache' : 'private, no-cache');
  if (!immutable && req.headers['if-none-match'] === bundle.etag) return reply.status(304).send();

  const accept = String(req.headers['accept-encoding'] ?? '');
  void reply.type('application/json; charset=utf-8');
  if (accept.includes('br')) {
    void reply.header('content-encoding', 'br');
    return reply.send(bundle.brotli);
  }
  if (accept.includes('gzip')) {
    void reply.header('content-encoding', 'gzip');
    return reply.send(bundle.gzip);
  }
  return reply.send(bundle.json);
}

export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  const reference = () => app.ctx.cache.data<ReferenceBundle>('reference');
  const rules = () => app.ctx.cache.data<RulesBundle>('rules');
  const content = () => app.ctx.cache.data<ContentBundle>('content');
  const workflow = () => app.ctx.cache.data<WorkflowBundle>('workflow');

  const cached = <T>(get: () => T) =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const etag = app.ctx.cache.get('reference').etag;
      void reply.header('cache-control', 'no-cache');
      void reply.header('etag', etag);
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
      return get();
    };

  app.get('/meta/versions', async (_req, reply) => {
    void reply.header('cache-control', 'no-cache');
    return { ...app.ctx.cache.versions(), schema: 1 };
  });

  app.get('/bundles/:bundle', async (req, reply) => {
    const { bundle } = z.object({ bundle: z.string() }).parse(req.params);
    assertBundle(bundle);
    await guardPrivate(app, req, bundle as BundleName);
    return sendBundle(app, req, reply, bundle as BundleName, false);
  });

  app.get('/bundles/:bundle/v/:version', async (req, reply) => {
    const { bundle, version } = z.object({ bundle: z.string(), version: z.coerce.number() }).parse(req.params);
    assertBundle(bundle);
    await guardPrivate(app, req, bundle as BundleName);
    const current = app.ctx.cache.get(bundle as BundleName);
    if (current.version !== version) {
      return reply.redirect(`${app.ctx.config.API_PREFIX}/bundles/${bundle}/v/${current.version}`, 302);
    }
    return sendBundle(app, req, reply, bundle as BundleName, true);
  });

  /** One round-trip for a cold client: reference + rules + content. */
  app.get('/bootstrap', async (_req, reply) => {
    void reply.header('cache-control', 'no-cache');
    return {
      versions: { ...app.ctx.cache.versions(), schema: 1 },
      reference: reference(),
      rules: rules(),
      content: content(),
    };
  });

  // ── The catalogue's 20 lookup endpoints ────────────────────────────────────
  const map: Record<string, () => unknown> = {
    'application-types': () => reference().applicationTypes,
    'build-types': () => reference().buildTypes,
    directions: () => reference().directions,
    districts: () => reference().districts,
    'fire-stations': () => reference().fireStations,
    hazards: () => reference().hazards,
    'mapped-codes': () => reference().mappedCodes,
    equipments: () => reference().equipments,
    'ffe-notes': () => reference().ffeNotes,
    statuses: () => reference().statuses,
    'dept-roles': () => reference().deptRoles,
    regions: () => reference().regions,
    'party-roles': () => reference().partyRoles,
    'block-options': () => reference().blockOptions,
    'document-requirements': () => reference().documentRequirements,
    'occupancy-conditions': () => reference().occupancyConditions,
    undertakings: () => reference().undertakings,
    'escape-rules': () => rules().escapeRules,
    'noc-terms': () => content().nocTerms,
    'nbc-table7': () => content().nbcTable7,
  };

  app.get('/lookups/:name', async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const get = map[name];
    if (!get) throw notFound(`Unknown lookup "${name}".`);
    return cached(get)(req, reply);
  });

  // ── Rule trees ─────────────────────────────────────────────────────────────
  app.get('/rules/ffe/:equipmentId', async (req, reply) => {
    const { equipmentId } = z.object({ equipmentId: z.string() }).parse(req.params);
    const tree = rules().ffe[equipmentId];
    if (!tree) throw notFound(`No FFE rule for equipment ${equipmentId}.`);
    return cached(() => tree)(req, reply);
  });
  app.get('/rules/ffe-type', async (req, reply) => cached(() => rules().ffeType)(req, reply));
  app.get('/rules/other-notes', async (req, reply) => cached(() => rules().otherNotes)(req, reply));
  app.get('/rules/riser-width', async (req, reply) => cached(() => rules().riserWidth)(req, reply));
  app.get('/rules/height-limits', async (req, reply) => cached(() => rules().heightLimits)(req, reply));

  /** Rule sets with their published versions (admin / other consumers). */
  app.get('/rules/sets', { preHandler: app.requirePortal('dept', 'admin') }, async () => {
    const b = rules();
    return Object.entries(b.sets).map(([code, v]) => ({ code, kind: v.kind, version: v.version, versionId: v.versionId }));
  });
  app.get('/rules/sets/:code', { preHandler: app.requirePortal('dept', 'admin') }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const set = rules().sets[code];
    if (!set) throw notFound(`Unknown rule set "${code}".`);
    return { code, ...set };
  });

  // ── Configuration (read) ───────────────────────────────────────────────────
  app.get('/config/fees', { preHandler: app.requireAuth }, async () => rules().feeConfig);
  app.get('/config/delegation-rules', { preHandler: app.requireAuth }, async () => rules().delegationRules);
  app.get('/config/renewal-rules', { preHandler: app.requireAuth }, async () => rules().renewalRules);
  app.get('/config/workflows', { preHandler: app.requirePortal('dept', 'admin') }, async () => workflow().workflows);
  app.get('/config/forms', { preHandler: app.requirePortal('dept', 'admin') }, async () => workflow().forms);
  app.get('/config/sla', { preHandler: app.requirePortal('dept', 'admin') }, async () => workflow().sla);
  app.get('/config/statuses', { preHandler: app.requireAuth }, async () => reference().statuses);
}

function assertBundle(name: string): void {
  const known = ['reference', 'rules', 'content', 'workflow', 'directory'];
  if (!known.includes(name)) throw notFound(`Unknown bundle "${name}".`);
}

async function guardPrivate(app: FastifyInstance, req: FastifyRequest, name: BundleName): Promise<void> {
  if (PUBLIC_BUNDLES.includes(name)) return;
  const handler = app.requirePortal('dept', 'admin');
  await (handler as unknown as (r: FastifyRequest, p: unknown) => Promise<void>)(req, undefined);
  if (!req.auth) throw forbidden();
}
