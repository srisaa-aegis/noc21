/**
 * Cross-cutting plugins: request id, the problem+json error handler, and the
 * `X-Data-Versions` header that lets the browser notice a configuration change
 * without polling (docs/backend/55-caching.md §55.6).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { WorkflowError } from '@srisaa/workflow-engine';
import { AppError, type FieldIssue } from '../errors/app-error.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId: string;
  errors?: FieldIssue[];
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'File too large',
  415: 'Unsupported file type',
  422: 'Cannot be processed',
  429: 'Too many requests',
  501: 'Not available yet',
  500: 'Unexpected error',
};

export const corePlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('requestId', '');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.requestId = (req.headers['x-request-id'] as string) || randomUUID();
    void reply.header('x-request-id', req.requestId);
  });

  app.setErrorHandler((error, req, reply) => {
    const problem = toProblem(error, req.requestId);
    if (problem.status >= 500) {
      req.log.error({ err: error, requestId: req.requestId }, 'request failed');
    } else {
      req.log.info({ requestId: req.requestId, status: problem.status, detail: problem.detail }, 'request rejected');
    }
    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: 'https://noc.portal/errors/not-found',
        title: 'Not found',
        status: 404,
        detail: `No route for ${req.method} ${req.url}.`,
        requestId: req.requestId,
      } satisfies Problem);
  });
});

/** Engine codes that mean "you may not" rather than "not possible right now". */
const WORKFLOW_FORBIDDEN = new Set(['not_assignee', 'not_decider']);

export function toProblem(error: unknown, requestId: string): Problem {
  if (error instanceof WorkflowError) {
    // A command the workflow engine refused: its message is written for the officer.
    const status = WORKFLOW_FORBIDDEN.has(error.code) ? 403 : 422;
    return { type: `https://noc.portal/errors/workflow-${error.code.replace(/_/g, '-')}`, title: TITLES[status] ?? 'Error', status, detail: error.message, requestId };
  }
  if (error instanceof AppError) {
    return {
      type: `https://noc.portal/errors/${error.type}`,
      title: TITLES[error.status] ?? 'Error',
      status: error.status,
      detail: error.message,
      requestId,
      ...(error.issues ? { errors: error.issues } : {}),
    };
  }
  const err = error as { validation?: unknown; statusCode?: number; message?: string; code?: string; cause?: unknown };
  const zod = error instanceof ZodError ? error : err.cause instanceof ZodError ? (err.cause as ZodError) : null;
  if (zod) {
    return {
      type: 'https://noc.portal/errors/validation',
      title: 'Cannot be processed',
      status: 400,
      detail: 'The request could not be understood. Please check the highlighted fields.',
      requestId,
      errors: zod.issues.map((i) => ({ field: i.path.join('.'), message: i.message, severity: 'error' as const })),
    };
  }
  if (err.statusCode === 429) {
    return {
      type: 'https://noc.portal/errors/rate-limited',
      title: TITLES[429],
      status: 429,
      detail: 'Too many attempts. Please wait a moment and try again.',
      requestId,
    };
  }
  if (err.statusCode && err.statusCode < 500) {
    return {
      type: 'https://noc.portal/errors/bad-request',
      title: TITLES[err.statusCode] ?? 'Error',
      status: err.statusCode,
      detail: err.message ?? 'The request could not be processed.',
      requestId,
    };
  }
  return {
    type: 'https://noc.portal/errors/internal',
    title: TITLES[500],
    status: 500,
    detail: 'Something went wrong on the server. Please try again; quote the request id if it persists.',
    requestId,
  };
}
