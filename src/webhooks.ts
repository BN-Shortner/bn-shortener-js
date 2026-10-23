/**
 * Check that a webhook really comes from BN Shortener.
 *
 * Every JSON delivery has `X-BN-Signature: t=<unix time>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Pass the RAW body (the exact bytes or string received, before JSON parsing) and the webhook's secret:
 * ```ts
 * const event = await constructEvent(rawBody, req.headers, process.env.BN_WEBHOOK_SECRET!); // throws WebhookVerificationError
 * ```
 * Works in Node 20+, Deno, Bun, Cloudflare Workers and browsers (Web Crypto).
 */
import { WebhookVerificationError } from './errors.js';

export const SIGNATURE_HEADER = 'X-BN-Signature';
export const DEFAULT_TOLERANCE = 300;

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

const bytes = (payload: string | Uint8Array | ArrayBuffer): Uint8Array =>
  typeof payload === 'string' ? new TextEncoder().encode(payload) : payload instanceof Uint8Array ? payload : new Uint8Array(payload);

async function hmacHex(secret: string, t: number, body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = new TextEncoder().encode(`${t}.`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix);
  msg.set(body, prefix.length);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** The X-BN-Signature value for a body (useful in your own tests). */
export async function sign(payload: string | Uint8Array | ArrayBuffer, secret: string, timestamp?: number): Promise<string> {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${await hmacHex(secret, t, bytes(payload))}`;
}

/** Throws WebhookVerificationError unless the signature matches and is at most `tolerance` seconds old. */
export async function verifySignature(
  payload: string | Uint8Array | ArrayBuffer, headers: HeaderBag, secret: string,
  o: { tolerance?: number; now?: number } = {},
): Promise<void> {
  const value = header(headers, SIGNATURE_HEADER);
  if (!value) throw new WebhookVerificationError(`No ${SIGNATURE_HEADER} header`);
  let t: number | undefined;
  const v1: string[] = [];
  for (const item of value.split(',')) {
    const i = item.indexOf('=');
    if (i < 0) continue;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (k === 't' && t === undefined) t = Number(v);
    if (k === 'v1') v1.push(v);
  }
  if (t === undefined || !Number.isFinite(t)) throw new WebhookVerificationError('Signature has no timestamp');
  const expected = await hmacHex(secret, t, bytes(payload));
  if (!v1.some((v) => same(expected, v))) {
    throw new WebhookVerificationError('Signature does not match (wrong secret, or the body was changed or re-encoded)');
  }
  const tolerance = o.tolerance ?? DEFAULT_TOLERANCE;
  const now = o.now ?? Date.now() / 1000;
  if (tolerance && Math.abs(now - t) > tolerance) throw new WebhookVerificationError('Signature is too old (replayed delivery?)');
}

/** Verify, then return the parsed event ({ id, event, timestamp, data, ... }). */
export async function constructEvent<T = Record<string, any>>(
  payload: string | Uint8Array | ArrayBuffer, headers: HeaderBag, secret: string, o: { tolerance?: number } = {},
): Promise<T> {
  await verifySignature(payload, headers, secret, o);
  return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(bytes(payload)));
}
