/**
 * Authentication and authorisation plugin.
 *
 * - access token: short-lived JWT in the Authorization header (held in memory
 *   by the SPA);
 * - refresh token: opaque, rotated, in an httpOnly cookie scoped to /auth;
 * - `requireAuth`, `requirePortal`, `requireRole` preHandlers;
 * - a user whose password must change can only reach /auth/*.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { config } from '../config/env.js';
import { forbidden, unauthenticated } from '../errors/app-error.js';
import { publicUser, type PublicUser } from '../services/auth.service.js';

export const REFRESH_COOKIE = 'noc_rt';

export interface AccessClaims {
  sub: number;
  username: string;
  portal: PublicUser['portal'];
  role?: number;
  mcp?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePortal: (...portals: PublicUser['portal'][]) => preHandlerHookHandler;
    signAccessToken: (user: PublicUser) => string;
    setRefreshCookie: (reply: FastifyReply, token: string) => void;
    clearRefreshCookie: (reply: FastifyReply) => void;
    currentUser: (req: FastifyRequest) => Promise<PublicUser>;
  }
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const cfg = config();
  await app.register(cookie, {});
  await app.register(jwt, {
    secret: cfg.JWT_ACCESS_SECRET,
    sign: { expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS },
  });

  app.decorateRequest('auth', undefined);

  app.decorate('signAccessToken', (user: PublicUser) =>
    app.jwt.sign({
      sub: user.id,
      username: user.username,
      portal: user.portal,
      role: user.role_id,
      mcp: user.must_change_password,
    } satisfies AccessClaims),
  );

  app.decorate('setRefreshCookie', (reply: FastifyReply, token: string) => {
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: cfg.COOKIE_SAMESITE,
      secure: cfg.COOKIE_SECURE,
      path: `${cfg.API_PREFIX}/auth`,
      maxAge: cfg.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
  });

  app.decorate('clearRefreshCookie', (reply: FastifyReply) => {
    void reply.clearCookie(REFRESH_COOKIE, { path: `${cfg.API_PREFIX}/auth` });
  });

  app.decorate('requireAuth', async function requireAuth(req: FastifyRequest) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    try {
      req.auth = app.jwt.verify<AccessClaims>(header.slice(7));
    } catch {
      throw unauthenticated('Your session has expired. Please sign in again.');
    }
    if (req.auth.mcp && !req.url.includes('/auth/')) {
      throw new (await import('../errors/app-error.js')).AppError(
        403,
        'forbidden',
        'Please change your temporary password before continuing.',
      );
    }
  } as preHandlerHookHandler);

  app.decorate('requirePortal', (...portals: PublicUser['portal'][]) => {
    const handler: preHandlerHookHandler = async (req) => {
      await (app.requireAuth as (r: FastifyRequest, p: FastifyReply) => Promise<void>)(req, undefined as never);
      if (!req.auth || !portals.includes(req.auth.portal)) {
        throw forbidden('You are not allowed to use this part of the portal.');
      }
    };
    return handler;
  });

  app.decorate('currentUser', async (req: FastifyRequest) => {
    if (!req.auth) throw unauthenticated();
    return publicUser(app.ctx.db, req.auth.sub);
  });
});
