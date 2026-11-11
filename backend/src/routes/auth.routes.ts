/** /auth — login, refresh, logout, me, register, forgot/reset, change password. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REFRESH_COOKIE } from '../plugins/auth.js';
import {
  changeOwnPassword,
  forgotPassword,
  login,
  logout,
  publicUser,
  refresh,
  register,
  resetPassword,
} from '../services/auth.service.js';
import { unauthenticated } from '../errors/app-error.js';

const loginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const registerBody = z.object({
  name: z.string().min(2),
  mobile: z.string().min(10),
  email: z.string().email(),
  gender: z.string().optional(),
  dob: z.string().optional(),
  aadhar: z.string().optional(),
  address: z.string().optional(),
});
const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });
const resetBody = z.object({ token: z.string().min(10), newPassword: z.string().min(1) });

export async function authRoutes(app: FastifyInstance, opts: { authLimit?: number } = {}): Promise<void> {
  /** Sign-in and the anonymous account operations: per address, to slow down guessing and mail flooding. */
  const limited = { config: { rateLimit: { max: opts.authLimit ?? app.ctx.config.RATE_LIMIT_LOGIN_PER_MINUTE, timeWindow: '1 minute' } } };
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? ''),
  });

  app.post('/auth/login', limited, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const result = await login(app.ctx.db, body.username, body.password, meta(req));
    app.setRefreshCookie(reply, result.refreshToken);
    return {
      user: result.user,
      accessToken: app.signAccessToken(result.user),
      expiresIn: app.ctx.config.ACCESS_TOKEN_TTL_SECONDS,
      landing: result.landing,
      dataVersions: app.ctx.cache.versions(),
    };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) throw unauthenticated('Your session has expired. Please sign in again.');
    const result = await refresh(app.ctx.db, raw, meta(req));
    app.setRefreshCookie(reply, result.refreshToken);
    return {
      user: result.user,
      accessToken: app.signAccessToken(result.user),
      expiresIn: app.ctx.config.ACCESS_TOKEN_TTL_SECONDS,
      landing: result.landing,
      dataVersions: app.ctx.cache.versions(),
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    await logout(app.ctx.db, req.cookies[REFRESH_COOKIE]);
    app.clearRefreshCookie(reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (req) => ({
    user: await publicUser(app.ctx.db, req.auth!.sub),
    dataVersions: app.ctx.cache.versions(),
  }));

  app.post('/auth/register', limited, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const result = await register(app.ctx.db, body);
    return reply.status(201).send({
      username: result.username,
      // The "set your password" link is e-mailed. Outside production it is also
      // returned, so the demo can continue without a mail server.
      ...(app.ctx.config.isProduction ? {} : { setPasswordUrl: result.setPasswordUrl }),
    });
  });

  app.post('/auth/forgot-password', limited, async (req, reply) => {
    const body = z.object({ email: z.string().min(3) }).parse(req.body);
    await forgotPassword(app.ctx.db, body.email);
    return reply.status(202).send({ accepted: true });
  });

  app.post('/auth/reset-password', limited, async (req, reply) => {
    const body = resetBody.parse(req.body);
    await resetPassword(app.ctx.db, body.token, body.newPassword);
    return reply.status(204).send();
  });

  app.put('/auth/password', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = changePasswordBody.parse(req.body);
    await changeOwnPassword(app.ctx.db, req.auth!.sub, body.currentPassword, body.newPassword);
    return reply.status(204).send();
  });
}
