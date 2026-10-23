import { BinaryResult, Page, RequestOptions, RequestSpec, Requester, StreamEvent } from './core.js';
import { APIConnectionError, APITimeoutError, AuthenticationError, BNError, OAuthError, errorFor } from './errors.js';
import { GeneratedResources } from './generated/resources.js';
import type { TokenSession } from './oauth.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://b1.lc/api/v1';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RETRY_WAIT_MS = 60_000;

export interface ClientOptions {
  /** API key (bn_live_...). Defaults to the BN_API_KEY environment variable in Node. */
  apiKey?: string;
  /** OAuth access token of a connected app (bn_oat_...). */
  accessToken?: string;
  /** Refreshes the OAuth access token by itself (see oauth.ts). */
  oauth?: TokenSession;
  baseUrl?: string;
  /** Milliseconds (default 30 000). */
  timeout?: number;
  /** Retries after connection errors, 408, 429 and 5xx (default 2). Writes carry an Idempotency-Key, so a retry never does the work twice. */
  maxRetries?: number;
  /** Names your integration in the account's usage (X-BN-Client), e.g. "acme-crm/2.1". */
  clientName?: string;
  defaultHeaders?: Record<string, string>;
  /** Your own fetch (tests, proxies, old runtimes). */
  fetch?: typeof fetch;
}

export interface LastResponse {
  status: number;
  headers: Headers;
  requestId?: string;
  rateLimit: { limit?: number; remaining?: number; reset?: number };
  idempotentReplay: boolean;
}

declare const process: { env?: Record<string, string | undefined> } | undefined;

const env = (name: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[name] : undefined;

function toQuery(query?: object): string {
  if (!query) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    q.append(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function randomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `bn-sdk-${c.randomUUID().replace(/-/g, '')}`;
  return `bn-sdk-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Client for the BN Shortener API v3 (https://b1.lc/docs/).
 *
 * ```ts
 * const bn = new BNShortener({ apiKey: process.env.BN_API_KEY });
 * const link = await bn.links.create({ url: 'https://example.com/spring-sale' });
 * ```
 */
export class BNShortener extends GeneratedResources implements Requester {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  lastResponse?: LastResponse;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;
  /** @internal for tests */
  sleep: (ms: number) => Promise<void> = sleep;

  constructor(options: ClientOptions = {}) {
    super();
    const apiKey = options.apiKey ?? (options.accessToken || options.oauth ? undefined : env('BN_API_KEY'));
    if (!apiKey && !options.accessToken && !options.oauth) {
      throw new BNError('Pass apiKey, accessToken or oauth (or set BN_API_KEY)');
    }
    this.opts = { ...options, apiKey };
    this.baseUrl = (options.baseUrl ?? env('BN_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new BNError('No fetch available: use Node 20+ or pass options.fetch');
    this.fetchImpl = f.bind(globalThis);
  }

  /** Every item of a list method, page after page: `for await (const link of bn.paginate(bn.links.list, { search: 'x' }))`. */
  async *paginate<T, A extends any[]>(method: (...args: A) => Promise<Page<T>>, ...args: A): AsyncGenerator<T> {
    let page: Page<T> | null = await method.apply(this, args);
    while (page) {
      yield* page.data;
      page = await page.nextPage();
    }
  }

  private async headers(options?: RequestOptions, accept = 'application/json'): Promise<Record<string, string>> {
    const h: Record<string, string> = { Accept: accept, 'X-BN-Client': this.opts.clientName ?? `bn-js/${VERSION}` };
    if (typeof window === 'undefined') h['User-Agent'] = `bn-shortener-js/${VERSION}`;
    Object.assign(h, this.opts.defaultHeaders);
    if (this.opts.oauth) {
      try {
        h.Authorization = `Bearer ${await this.opts.oauth.getAccessToken()}`;
      } catch (e) {
        // the sign-in ended (disconnected, revoked, expired): the app must connect again
        if (e instanceof OAuthError && e.ended) {
          throw new AuthenticationError(401, { title: 'Authentication Required', detail: `Could not refresh the access token (${e.message})` }, new Headers());
        }
        if (e instanceof OAuthError) throw new APIConnectionError(`The token endpoint is unavailable (${e.message}); try again`, e);
        throw e;
      }
    }
    else if (this.opts.accessToken) h.Authorization = `Bearer ${this.opts.accessToken}`;
    else h['X-API-Key'] = this.opts.apiKey as string;
    Object.assign(h, options?.headers);
    return h;
  }

  private url(spec: RequestSpec, query?: object): string {
    let path = spec.path;
    for (const [k, v] of Object.entries(spec.pathParams ?? {})) {
      path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
    return this.baseUrl + path + toQuery(query ?? spec.query);
  }

  private retryWait(attempt: number, headers?: Headers): number {
    const ra = headers?.get('retry-after');
    if (ra && !Number.isNaN(Number(ra))) return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, Number(ra) * 1000));
    return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
  }

  private checkAborted(options?: RequestOptions): void {
    const s = options?.signal;
    if (s?.aborted) throw s.reason ?? new BNError('The request was aborted');
  }

  /**
   * Sends with retries. The returned `release` must be called once the body has been read: until then the timeout
   * still applies (a server that sends headers and then stalls must not hang the call).
   */
  private async send(method: string, url: string, body: unknown, options?: RequestOptions, accept?: string): Promise<{ resp: Response; release: () => void; timedOut: () => boolean }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const idem = WRITE_METHODS.has(method) ? options?.idempotencyKey ?? randomKey() : undefined;
    let attempt = 0;
    let retriedAuth = false;
    for (;;) {
      this.checkAborted(options);
      const headers = await this.headers(options, accept);
      if (data !== undefined) headers['Content-Type'] = 'application/json';
      if (idem) headers['Idempotency-Key'] = idem;
      const ctrl = new AbortController();
      const ms = options?.timeout ?? this.timeout;
      let fired = false;
      const timer = setTimeout(() => {
        fired = true;
        ctrl.abort();
      }, ms);
      const onAbort = () => ctrl.abort();
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      const release = () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      };
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, { method, headers, body: data, signal: ctrl.signal, redirect: 'manual' });
      } catch (e) {
        release();
        if (options?.signal?.aborted) throw e;
        const err = fired
          ? new APITimeoutError(`No answer within ${ms} ms`, e)
          : new APIConnectionError(`Could not reach ${url.split('?')[0]}: ${(e as Error)?.message ?? e}`, e);
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryWait(attempt));
          attempt += 1;
          continue;
        }
        throw err;
      }
      const n = (k: string) => (resp.headers.get(k) != null ? Number(resp.headers.get(k)) : undefined);
      this.lastResponse = {
        status: resp.status, headers: resp.headers, requestId: resp.headers.get('x-request-id') ?? undefined,
        rateLimit: { limit: n('x-ratelimit-limit'), remaining: n('x-ratelimit-remaining'), reset: n('x-ratelimit-reset') },
        idempotentReplay: resp.headers.get('idempotency-replayed') === 'true' || resp.headers.get('x-idempotency-replayed') === 'true',
      };
      if (resp.status === 401 && this.opts.oauth && !retriedAuth && this.opts.oauth.canRefresh()) {
        retriedAuth = true; // the access token may have been revoked or expired early: refresh once
        try {
          await this.opts.oauth.refreshNow(headers.Authorization.slice('Bearer '.length));
        } catch (e) {
          // the sign-in itself ended: the caller gets the 401 as AuthenticationError
          if (e instanceof OAuthError && e.ended) return { resp, release, timedOut: () => fired };
          release();
          if (e instanceof OAuthError) throw new APIConnectionError(`The token endpoint is unavailable (${e.message}); try again`, e);
          throw e;
        }
        await resp.body?.cancel().catch(() => undefined);
        release();
        continue;
      }
      // 409 + Retry-After = our earlier try with this Idempotency-Key is still running (e.g. after a timeout):
      // asking again shortly returns its stored answer. A real conflict (code taken) has no Retry-After.
      const inFlight = resp.status === 409 && Boolean(idem) && resp.headers.has('retry-after');
      if ((RETRY_STATUSES.has(resp.status) || inFlight) && attempt < this.maxRetries) {
        await resp.body?.cancel().catch(() => undefined);
        release();
        await this.sleep(this.retryWait(attempt, resp.headers));
        attempt += 1;
        continue;
      }
      return { resp, release, timedOut: () => fired };
    }
  }

  private async raiseFor(resp: Response): Promise<never> {
    const text = await resp.text().catch(() => '');
    let problem: Record<string, any>;
    try {
      problem = text ? JSON.parse(text) : {};
    } catch {
      problem = { title: `HTTP ${resp.status}`, detail: text.slice(0, 200) };
    }
    throw errorFor(resp.status, problem, resp.headers);
  }

  /** Call any endpoint (also ones this version does not wrap yet). `path` is relative to baseUrl, e.g. '/links'. */
  async request<T = any>(spec: RequestSpec, options?: RequestOptions): Promise<T> {
    const { resp, release, timedOut } = await this.send(spec.method, this.url(spec), spec.body, options);
    try {
      return await this.read<T>(spec, resp, options);
    } catch (e) {
      if (timedOut()) throw new APITimeoutError(`The answer did not arrive within ${options?.timeout ?? this.timeout} ms`, e);
      throw e;
    } finally {
      release();
    }
  }

  private async read<T>(spec: RequestSpec, resp: Response, options?: RequestOptions): Promise<T> {
    // the API never redirects; a 3xx means a proxy or a wrong baseUrl (status 0 = opaque redirect in browsers)
    if (resp.status >= 300 || resp.status === 0) return this.raiseFor(resp);
    const ctype = resp.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) {
      if (resp.status === 204) return undefined as T;
      const data = new Uint8Array(await resp.arrayBuffer());
      const cd = resp.headers.get('content-disposition') ?? '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const result: BinaryResult = {
        contentType: ctype.split(';')[0].trim(), filename: m ? m[1] : undefined, data, headers: resp.headers,
        text: () => new TextDecoder().decode(data),
      };
      return result as T;
    }
    const text = await resp.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (payload && typeof payload === 'object' && 'success' in payload && 'data' in payload) {
      if (spec.paged) {
        const fetchPage = (page: number) =>
          this.request<Page<any>>({ ...spec, query: { ...(spec.query ?? {}), page } }, options);
        return new Page(payload.data ?? [], payload.meta ?? {}, fetchPage) as T;
      }
      return payload.data as T;
    }
    return payload as T;
  }

  /** Server-sent events as objects. Stop with `break` or options.signal. */
  async *stream(spec: RequestSpec, options?: RequestOptions): AsyncGenerator<StreamEvent> {
    const opts = { ...options, timeout: options?.timeout ?? 3_600_000 };
    const { resp, release } = await this.send('GET', this.url(spec), undefined, opts, 'text/event-stream');
    if (resp.status >= 300 || resp.status === 0) {
      try {
        return await this.raiseFor(resp);
      } finally {
        release();
      }
    }
    release(); // a live stream has no overall timeout; options.signal still stops it via the reader below
    const stop = () => void reader.cancel().catch(() => undefined);
    options?.signal?.addEventListener('abort', stop, { once: true });
    if (!resp.body) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let event: string | undefined;
    let data: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line === '') {
            if (data.length) {
              const raw = data.join('\n');
              let item: StreamEvent;
              try {
                item = JSON.parse(raw);
              } catch {
                item = { data: raw };
              }
              if (event && item && typeof item === 'object' && item.event === undefined) item.event = event;
              yield item;
            }
            event = undefined;
            data = [];
          } else if (line.startsWith(':')) {
            continue;
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''));
          }
        }
      }
    } finally {
      options?.signal?.removeEventListener('abort', stop);
      await reader.cancel().catch(() => undefined);
    }
  }
}
