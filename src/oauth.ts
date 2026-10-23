/**
 * OAuth 2.1 for apps that act for BN Shortener users (https://b1.lc/docs/oauth/).
 *
 * Web apps and integrations (authorization code + PKCE):
 * ```ts
 * const app = new OAuthClient({ clientId: 'bnc_...', redirectUri: 'https://example.com/callback' });
 * const auth = await app.authorizationUrl({ scope: ['read', 'write'] }); // keep auth.state + auth.codeVerifier
 * // ... send the person to auth.url; b1.lc sends them back to the redirect URI ...
 * const code = app.parseCallback(callbackUrl, auth.state);
 * const token = await app.exchangeCode(code, auth.codeVerifier);
 * ```
 *
 * Command-line tools and devices without a browser (device flow):
 * ```ts
 * const device = await app.startDeviceFlow({ scope: ['read', 'write'] });
 * console.log(`Open ${device.verification_uri} and type ${device.user_code}`);
 * const token = await app.waitForDevice(device);
 * ```
 *
 * Then `new BNShortener({ oauth: new TokenSession(app, token, { onRefresh: save }) })`: the session refreshes the
 * 1-hour access token by itself and calls onRefresh with every new token (refresh tokens rotate on each use).
 */
import { APIConnectionError, BNError, OAuthError } from './errors.js';
import { VERSION } from './version.js';

export const DEFAULT_ISSUER = 'https://b1.lc';
export const SCOPES = ['read', 'write', 'delete', 'webhooks'] as const;
export type Scope = (typeof SCOPES)[number];
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface Token {
  access_token: string;
  refresh_token?: string;
  /** Unix time in milliseconds. */
  expires_at: number;
  scope: string;
  token_type: string;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  started_at: number;
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return b64url(a);
}

/** { codeVerifier, codeChallenge } for PKCE S256. */
export async function generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomString(48);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: b64url(new Uint8Array(digest)) };
}

const scopeText = (scope?: string | readonly string[]) => (scope === undefined ? undefined : typeof scope === 'string' ? scope : scope.join(' '));

function tokenFrom(d: Record<string, any>): Token {
  return {
    access_token: d.access_token, refresh_token: d.refresh_token, scope: d.scope ?? '', token_type: d.token_type ?? 'Bearer',
    expires_at: Date.now() + Number(d.expires_in ?? 3600) * 1000,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface OAuthClientOptions {
  clientId: string;
  /** Confidential (server-side) apps only; never ship it in a browser or CLI. */
  clientSecret?: string;
  redirectUri?: string;
  issuer?: string;
  /** Milliseconds per request to the token endpoint (default 30 000). */
  timeout?: number;
  fetch?: typeof fetch;
}

/** One registered app. */
export class OAuthClient {
  readonly clientId: string;
  readonly issuer: string;
  private readonly opts: OAuthClientOptions;
  private readonly fetchImpl: typeof fetch;
  /** @internal for tests */
  sleep: (ms: number) => Promise<void> = sleep;

  constructor(options: OAuthClientOptions) {
    this.opts = options;
    this.clientId = options.clientId;
    this.issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '');
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new BNError('No fetch available: use Node 20+ or pass options.fetch');
    this.fetchImpl = f.bind(globalThis);
  }

  async authorizationUrl(o: { scope?: string | readonly string[]; redirectUri?: string; state?: string } = {}): Promise<AuthorizationRequest> {
    const redirectUri = o.redirectUri ?? this.opts.redirectUri;
    if (!redirectUri) throw new BNError('redirectUri is required');
    const state = o.state ?? randomString(24);
    const { codeVerifier, codeChallenge } = await generatePkce();
    const q = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri, scope: scopeText(o.scope ?? ['read']) as string,
      state, code_challenge: codeChallenge, code_challenge_method: 'S256',
    });
    return { url: `${this.issuer}/api/oauth/authorize?${q}`, state, codeVerifier };
  }

  /** The code from the redirect back to your app, after checking state and issuer (RFC 9207). */
  parseCallback(url: string, expectedState: string): string {
    const q = new URL(url).searchParams;
    if (!expectedState || q.get('state') !== expectedState) throw new OAuthError('invalid_state', 'state does not match: start the sign-in again');
    const iss = q.get('iss');
    if (iss && iss !== this.issuer) throw new OAuthError('invalid_issuer', `answer came from ${iss}, expected ${this.issuer}`);
    const error = q.get('error');
    if (error) throw new OAuthError(error, q.get('error_description') ?? undefined);
    const code = q.get('code');
    if (!code) throw new OAuthError('invalid_request', 'no code in the callback URL');
    return code;
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri?: string): Promise<Token> {
    return tokenFrom(await this.post('/api/oauth/token', {
      grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? this.opts.redirectUri,
    }));
  }

  /** A new access token AND a new refresh token: store the new refresh token, the old one stops working. */
  async refresh(refreshToken: string): Promise<Token> {
    return tokenFrom(await this.post('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }));
  }

  /** Ends the token (a refresh token ends the whole sign-in). */
  async revoke(token: string): Promise<void> {
    await this.post('/api/oauth/revoke', { token });
  }

  async startDeviceFlow(o: { scope?: string | readonly string[] } = {}): Promise<DeviceAuthorization> {
    const d = await this.post('/api/oauth/device/code', { scope: scopeText(o.scope ?? ['read']) });
    return {
      device_code: d.device_code, user_code: d.user_code, verification_uri: d.verification_uri,
      verification_uri_complete: d.verification_uri_complete ?? d.verification_uri,
      expires_in: Number(d.expires_in ?? 600), interval: Number(d.interval ?? 5), started_at: Date.now(),
    };
  }

  /** Poll until the person approves (Token) or cancels / the code expires (OAuthError). */
  async waitForDevice(device: DeviceAuthorization, o: { signal?: AbortSignal } = {}): Promise<Token> {
    let interval = device.interval;
    for (;;) {
      if (Date.now() - device.started_at > device.expires_in * 1000) throw new OAuthError('expired_token', 'The code expired: start again');
      await this.sleep(interval * 1000);
      if (o.signal?.aborted) throw new OAuthError('cancelled', 'Stopped waiting');
      try {
        return tokenFrom(await this.post('/api/oauth/token', { grant_type: DEVICE_GRANT, device_code: device.device_code }));
      } catch (e) {
        if (e instanceof OAuthError && e.error === 'authorization_pending') continue;
        if (e instanceof OAuthError && (e.error === 'slow_down' || !e.ended)) {
          interval += 5; // slow down; a 5xx is temporary: keep waiting
          continue;
        }
        if (e instanceof APIConnectionError) {
          interval = Math.min(interval + 5, 30); // network blip while the person is approving: keep waiting
          continue;
        }
        throw e;
      }
    }
  }

  private async post(path: string, form: Record<string, string | undefined>): Promise<Record<string, any>> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
    body.set('client_id', this.clientId);
    if (this.opts.clientSecret) body.set('client_secret', this.opts.clientSecret);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (typeof window === 'undefined') headers['User-Agent'] = `bn-shortener-js/${VERSION}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeout ?? 30_000);
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(this.issuer + path, { method: 'POST', headers, body: body.toString(), signal: ctrl.signal });
      text = await resp.text();
    } catch (e) {
      throw new APIConnectionError(`Could not reach ${this.issuer}${path}: ${(e as Error)?.message ?? e}`, e);
    } finally {
      clearTimeout(timer);
    }
    let data: Record<string, any> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (resp.status >= 400) throw new OAuthError(data.error ?? `http_${resp.status}`, data.error_description, resp.status);
    return data;
  }
}

/** Keeps a Token fresh for `new BNShortener({ oauth })`. onRefresh runs after every refresh: save the token there. */
export class TokenSession {
  token: Token;
  private pending?: Promise<Token>;

  constructor(readonly client: OAuthClient, token: Token, private readonly o: { onRefresh?: (t: Token) => void | Promise<void> } = {}) {
    this.token = token;
  }

  canRefresh(): boolean {
    return Boolean(this.token.refresh_token);
  }

  async getAccessToken(): Promise<string> {
    if (Date.now() >= this.token.expires_at - 60_000 && this.canRefresh()) return this.refreshNow(this.token.access_token);
    return this.token.access_token;
  }

  /** Refreshes unless another call already replaced `onlyIf`; concurrent callers share one refresh. */
  async refreshNow(onlyIf?: string): Promise<string> {
    if (onlyIf !== undefined && this.token.access_token !== onlyIf) return this.token.access_token;
    if (!this.canRefresh()) return this.token.access_token;
    if (!this.pending) {
      this.pending = (async () => {
        try {
          const t = await this.client.refresh(this.token.refresh_token as string);
          this.token = t;
          await this.o.onRefresh?.(t);
          return t;
        } finally {
          this.pending = undefined;
        }
      })();
    }
    return (await this.pending).access_token;
  }
}
