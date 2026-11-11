/**
 * Configuration writes (phase B3): fees, approval-level and renewal rules (new
 * rule-set versions), department workflows (new definition versions), SLA.
 * The reads stay in reference.routes.ts (served from the cache).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WorkflowDefinition } from '@srisaa/noc-domain';
import {
  evaluateRuleSet,
  restoreWorkflowVersion,
  ruleSetVersions,
  saveDelegationRules,
  saveFees,
  saveRenewalRules,
  saveSla,
  saveWorkflow,
  simulateWorkflow,
  validateWorkflow,
  workflowDefaults,
  workflowUsage,
  workflowVersions,
} from '../services/config.service.js';
import { contextFactory } from './helpers.js';

const anyObject = z.record(z.string(), z.unknown());
const workflowBody = z.object({ name: z.string(), stages: z.array(anyObject) }).passthrough();

export async function configRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: app.requirePortal('admin') };
  const ctxOf = contextFactory(app);
  const rules = () => app.ctx.cache.data<{ feeConfig: unknown; delegationRules: unknown; renewalRules: unknown }>('rules');

  // ── Rules ──────────────────────────────────────────────────────────────────
  app.put('/config/fees', admin, async (req) => {
    await saveFees(await ctxOf(req), anyObject.parse(req.body) as never);
    await app.ctx.cache.checkVersions();
    return rules().feeConfig;
  });
  app.put('/config/delegation-rules', admin, async (req) => {
    await saveDelegationRules(await ctxOf(req), z.array(anyObject).parse(req.body) as never);
    await app.ctx.cache.checkVersions();
    return rules().delegationRules;
  });
  app.put('/config/renewal-rules', admin, async (req) => {
    await saveRenewalRules(await ctxOf(req), z.array(anyObject).parse(req.body) as never);
    await app.ctx.cache.checkVersions();
    return rules().renewalRules;
  });
  app.get('/config/rules/:code/versions', admin, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    return { items: await ruleSetVersions(await ctxOf(req), code) };
  });
  app.post('/rules/sets/:code/evaluate', { preHandler: app.requirePortal('admin', 'dept') }, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const body = z.object({ facts: z.union([anyObject, z.array(anyObject)]) }).parse(req.body);
    return evaluateRuleSet(await ctxOf(req), code, body.facts);
  });

  // ── Workflows ──────────────────────────────────────────────────────────────
  app.get('/config/workflows/defaults', admin, async (req) => workflowDefaults(await ctxOf(req)));
  app.get('/config/workflows/usage', admin, async (req) => workflowUsage(await ctxOf(req)));
  app.post('/config/workflows/validate', admin, async (req) => {
    const def = anyObject.parse(req.body) as unknown as WorkflowDefinition;
    return { problems: validateWorkflow(await ctxOf(req), def) };
  });
  app.post('/config/workflows/simulate', { preHandler: app.requirePortal('admin', 'dept') }, async (req) => {
    const body = z.object({ definition: anyObject, fire_station_id: z.coerce.number().int().positive() }).parse(req.body);
    return { tasks: simulateWorkflow(await ctxOf(req), body.definition as unknown as WorkflowDefinition, body.fire_station_id) };
  });
  app.put('/config/workflows/:code', admin, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const saved = await saveWorkflow(await ctxOf(req), code, workflowBody.parse(req.body) as never);
    await app.ctx.cache.checkVersions();
    return saved;
  });
  app.get('/config/workflows/:code/versions', admin, async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    return { items: await workflowVersions(await ctxOf(req), code) };
  });
  app.post('/config/workflows/:code/restore/:version', admin, async (req) => {
    const { code, version } = z.object({ code: z.string(), version: z.coerce.number().int().positive() }).parse(req.params);
    const restored = await restoreWorkflowVersion(await ctxOf(req), code, version);
    await app.ctx.cache.checkVersions();
    return restored;
  });

  // ── SLA ─────────────────────────────────────────────────────────────────────
  app.put('/config/sla', admin, async (req) => {
    await saveSla(await ctxOf(req), anyObject.parse(req.body) as never);
    await app.ctx.cache.checkVersions();
    return app.ctx.cache.data<{ sla: unknown }>('workflow').sla;
  });
}
