/**
 * The error model. Everything thrown by a service is an AppError, which the
 * error handler renders as RFC 9457 problem+json. `detail` is always a
 * user-presentable sentence — the portal shows it verbatim, which is why the
 * messages match the ones the browser used to produce.
 */
export type ProblemType =
  | 'bad-request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'open-tasks'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'validation'
  | 'business-rule'
  | 'rate-limited'
  | 'not-implemented'
  | 'internal';

export interface FieldIssue {
  field: string;
  message: string;
  step?: string;
  block?: number;
  blockStep?: string;
  severity?: 'error' | 'warning';
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: ProblemType,
    message: string,
    readonly issues?: FieldIssue[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string) => new AppError(400, 'bad-request', m);
export const unauthenticated = (m = 'Please sign in to continue.') => new AppError(401, 'unauthenticated', m);
export const forbidden = (m = 'You are not allowed to do this.') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new AppError(404, 'not-found', m);
export const conflict = (m: string) => new AppError(409, 'conflict', m);
export const businessRule = (m: string) => new AppError(422, 'business-rule', m);
export const validationFailed = (m: string, issues: FieldIssue[]) => new AppError(422, 'validation', m, issues);
export const notImplemented = (m: string) => new AppError(501, 'not-implemented', m);

/** Guard used throughout the services: `assert(cond, 'message')`. */
export function assert(condition: unknown, message: string, status = 422): asserts condition {
  if (!condition) throw new AppError(status, status === 404 ? 'not-found' : 'business-rule', message);
}
