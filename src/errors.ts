/** Base class of every error this package throws. */
export class BNError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request did not get an answer (DNS, refused connection, TLS, reset). */
export class APIConnectionError extends BNError {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

/** No answer within the timeout. */
export class APITimeoutError extends APIConnectionError {}

export interface FieldError {
  field?: string;
  code?: string;
  message?: string;
}

/**
 * The API answered with an error status. `type` links to a page that explains the error
 * (https://b1.lc/docs/errors/...); `errors` lists field problems on 422; quote `requestId` to support.
 */
export class APIError extends BNError {
  readonly status: number;
  readonly problem: Record<string, any>;
  readonly type?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly errors: FieldError[];
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly headers: Headers;

  constructor(status: number, problem: Record<string, any> | undefined, headers: Headers) {
    const p = problem && typeof problem === 'object' ? problem : {};
    const title: string | undefined = p.title;
    const detail: string | undefined = p.detail ?? p.error_description ?? p.message;
    const requestId: string | undefined = p.trace_id ?? headers.get('x-request-id') ?? undefined;
    let text = title ?? `HTTP ${status}`;
    if (detail && detail !== title) text += `: ${detail}`;
    const fields = (Array.isArray(p.errors) ? p.errors : []).filter((e: FieldError) => e && e.field).map((e: FieldError) => `${e.field}: ${e.message}`);
    if (fields.length) text += ` (${fields.join('; ')})`;
    if (requestId) text += ` (request ${requestId})`;
    super(text);
    this.status = status;
    this.problem = p;
    this.type = p.type;
    this.title = title;
    this.detail = detail;
    this.errors = Array.isArray(p.errors) ? p.errors : [];
    this.requestId = requestId;
    const ra = p.retry_after ?? headers.get('retry-after');
    this.retryAfter = ra != null && !Number.isNaN(Number(ra)) ? Number(ra) : undefined;
    this.headers = headers;
  }
}

export class BadRequestError extends APIError {}
/** 401: missing, wrong, expired or revoked key or token. */
export class AuthenticationError extends APIError {}
/** 403: the key or app lacks the permission (read, write, delete, webhooks, admin). */
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
/** 409: e.g. the short code is taken, or the same Idempotency-Key is still in flight. */
export class ConflictError extends APIError {}
/** 422: see `errors` for the fields. */
export class ValidationError extends APIError {}
/** 429: see `retryAfter`. */
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}

export function errorFor(status: number, problem: Record<string, any> | undefined, headers: Headers): APIError {
  const map: Record<number, typeof APIError> = {
    400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError, 404: NotFoundError,
    409: ConflictError, 422: ValidationError, 429: RateLimitError,
  };
  const Cls = map[status] ?? (status >= 500 ? InternalServerError : APIError);
  return new Cls(status, problem, headers);
}

/** The authorization server refused (RFC 6749 `error` + `error_description`). */
export class OAuthError extends BNError {
  constructor(readonly error: string, readonly description?: string, readonly status?: number) {
    super(description ? `${error}: ${description}` : error);
  }

  /** True when the grant is gone for good (connect again); false for a temporary failure (5xx). */
  get ended(): boolean {
    return this.status === undefined || this.status < 500;
  }
}

/** The webhook signature is missing, wrong or too old. */
export class WebhookVerificationError extends BNError {}
