/**
 * OpenAPI 3.1 description of the API, with Swagger UI at /docs (ENABLE_DOCS,
 * on by default outside production; the JSON is at /docs/json).
 *
 * The routes validate their input with Zod inside the handlers, so the
 * document lists every operation with its path parameters, its group and
 * whether it needs a bearer token; the request and response shapes are
 * described in docs/backend/50-api-design.md and the portal's catalogue
 * (frontend/src/app/core/api/api-endpoints.ts), which the contract test keeps
 * in step with this API.
 */
import type { FastifyInstance, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/** Operations that need no bearer token (everything else does). */
export function isPublicRoute(path: string): boolean {
  return (
    /\/auth\/(login|refresh|logout|register|forgot-password|reset-password)$/.test(path) ||
    /\/(meta\/versions|bootstrap|lookups\/:name|files\/download\/:token)$/.test(path) ||
    /\/bundles\//.test(path) ||
    /\/rules\/(ffe|ffe-type|other-notes|riser-width|height-limits)(\/|$)/.test(path) ||
    /^\/(health|ready|version)$/.test(path)
  );
}

const TAGS: [RegExp, string][] = [
  [/^\/(health|ready|version)$/, 'Operations'],
  [/\/auth\//, 'Authentication'],
  [/\/(meta|bundles|bootstrap|lookups)(\/|$)/, 'Reference data'],
  [/\/rules\/sets/, 'Configuration'],
  [/\/rules\//, 'Reference data'],
  [/\/config\//, 'Configuration'],
  [/\/dept\/reports/, 'Reports'],
  [/\/dept\//, 'Department'],
  [/\/admin\/|\/audit$/, 'Administration'],
  [/\/files\//, 'Files'],
  [/\/(applications|assessments)/, 'Applications'],
];

export const openApiPlugin = fp<{ prefix: string }>(async (app: FastifyInstance, opts) => {
  app.addHook('onRoute', (route: RouteOptions) => {
    if (route.url.startsWith('/docs')) return;
    const path = route.url.startsWith(opts.prefix) ? route.url.slice(opts.prefix.length) || '/' : route.url;
    const tag = TAGS.find(([re]) => re.test(path) || re.test(route.url))?.[1] ?? 'Other';
    route.schema = {
      ...(route.schema ?? {}),
      tags: [tag],
      summary: `${[route.method].flat().join(', ')} ${path}`,
      ...(isPublicRoute(route.url) ? {} : { security: [{ bearer: [] }] }),
    };
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Fire NOC Portal API',
        version: '1.0.0',
        description:
          'The backend of the Fire NOC portal (phase B3). Sign in with POST /api/v1/auth/login and use the `accessToken` as a bearer token. ' +
          'Errors are RFC 9457 problem+json. Request and response shapes: docs/backend/50-api-design.md.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      tags: ['Authentication', 'Reference data', 'Applications', 'Files', 'Department', 'Reports', 'Administration', 'Configuration', 'Operations'].map(
        (name) => ({ name }),
      ),
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });
});
