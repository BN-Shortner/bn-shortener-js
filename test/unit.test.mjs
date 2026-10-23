// Unit tests with a fake fetch: retries, idempotency keys, errors, pagination, webhook signatures, PKCE.
// Run: npm test (builds first). tests/test_sdk.py also runs these plus integration.test.mjs against a local API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BNShortener, Page, RateLimitError, ValidationError, APIConnectionError, webhooks, generatePkce, OAuthClient, OAuthError, WebhookVerificationError } from '../dist/esm/index.js';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fake(responder) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length, url, init);
  };
  return { f, calls };
}

test('unwraps data, sends key, client name and an idempotency key on writes', async () => {
  const { f, calls } = fake(() => json(201, { success: true, data: { id: 7, short_url: 'https://b1.lc/AbC9' }, meta: {} }, { 'x-request-id': 'req_1' }));
  const bn = new BNShortener({ apiKey: 'bn_live_x', fetch: f });
  const link = await bn.links.create({ url: 'https://example.com' });
  assert.equal(link.id, 7);
  const h = calls[0].init.headers;
  assert.equal(h['X-API-Key'], 'bn_live_x');
  assert.match(h['X-BN-Client'], /^bn-js\//);
  assert.match(h['Idempotency-Key'], /^bn-sdk-[0-9a-f]{32}$/);
  assert.equal(calls[0].init.body, JSON.stringify({ url: 'https://example.com' }));
  assert.equal(bn.lastResponse.requestId, 'req_1');
});

test('retries 5xx with the same idempotency key, honours Retry-After, then throws', async () => {
  const { f, calls } = fake((n) => (n < 3 ? new Response('bad gateway', { status: 502 }) : json(200, { success: true, data: { ok: 1 }, meta: {} })));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  const waits = [];
  bn.sleep = async (ms) => void waits.push(ms);
  await bn.links.archive(5);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[2].init.headers['Idempotency-Key']);

  const limited = fake(() => json(429, { type: 'https://b1.lc/docs/errors/rate-limit-exceeded', title: 'Rate Limit Exceeded', status: 429, detail: 'x', retry_after: 3 }, { 'retry-after': '3' }));
  const bn2 = new BNShortener({ apiKey: 'k', fetch: limited.f, maxRetries: 1 });
  const waits2 = [];
  bn2.sleep = async (ms) => void waits2.push(ms);
  await assert.rejects(bn2.links.list(), (e) => e instanceof RateLimitError && e.retryAfter === 3);
  assert.deepEqual(waits2, [3000]);
  assert.equal(limited.calls.length, 2);
});

test('connection errors are retried and then raised as APIConnectionError', async () => {
  const { f, calls } = fake(() => { throw new TypeError('fetch failed'); });
  const bn = new BNShortener({ apiKey: 'k', fetch: f, maxRetries: 2 });
  bn.sleep = async () => {};
  await assert.rejects(bn.system.ping(), APIConnectionError);
  assert.equal(calls.length, 3);
});

test('422 becomes ValidationError with the field errors', async () => {
  const { f } = fake(() => json(422, { type: 'https://b1.lc/docs/errors/validation-failed', title: 'Validation Failed', status: 422, detail: 'bad', errors: [{ field: 'url', code: 'INVALID', message: 'm' }], trace_id: 'req_9' }));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  await assert.rejects(bn.links.create({ url: 'x' }), (e) => e instanceof ValidationError && e.errors[0].field === 'url' && e.requestId === 'req_9' && e.status === 422);
});

test('pages and paginate()', async () => {
  const { f, calls } = fake((n, url) => {
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    return json(200, { success: true, data: [page * 10, page * 10 + 1], meta: { pagination: { page, per_page: 2, total_pages: 3, has_next: page < 3 } } });
  });
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  const first = await bn.links.list({ per_page: 2, search: 'x' });
  assert.ok(first instanceof Page);
  assert.deepEqual([...first], [10, 11]);
  const all = [];
  for await (const v of bn.paginate(bn.links.list, { per_page: 2 })) all.push(v);
  assert.deepEqual(all, [10, 11, 20, 21, 30, 31]);
  assert.match(calls.at(-1).url, /per_page=2/);
});

test('binary answers', async () => {
  const { f } = fake(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="qr.png"' } }));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  const img = await bn.qrCodes.image(3, { format: 'png' });
  assert.equal(img.contentType, 'image/png');
  assert.equal(img.filename, 'qr.png');
  assert.equal(img.data[0], 0x89);
});

test('webhook signatures: sign/verify round trip, and a Python-made signature verifies', async () => {
  const sig = await webhooks.sign('{"a":1}', 's3cret');
  await webhooks.verifySignature('{"a":1}', { 'x-bn-signature': sig }, 's3cret');
  await assert.rejects(webhooks.verifySignature('{"a":2}', { 'X-BN-Signature': sig }, 's3cret'), WebhookVerificationError);
  await assert.rejects(webhooks.verifySignature('{"a":1}', new Headers({ 'X-BN-Signature': sig }), 's3cret', { now: Date.now() / 1000 + 3600 }), WebhookVerificationError);
  await assert.rejects(webhooks.verifySignature('{"a":1}', {}, 's3cret'), WebhookVerificationError);
  if (process.env.BN_TEST_WEBHOOK_SIG) {
    const ev = await webhooks.constructEvent(process.env.BN_TEST_WEBHOOK_BODY, { 'X-BN-Signature': process.env.BN_TEST_WEBHOOK_SIG }, process.env.BN_TEST_WEBHOOK_SECRET);
    assert.equal(ev.event, 'link.created');
  }
});

test('PKCE and callback checks', async () => {
  const { codeVerifier, codeChallenge } = await generatePkce();
  assert.ok(codeVerifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(codeChallenge));
  const app = new OAuthClient({ clientId: 'bnc_x', redirectUri: 'https://app.example.com/cb', fetch: async () => json(200, {}) });
  const auth = await app.authorizationUrl({ scope: ['read', 'write'] });
  const u = new URL(auth.url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'read write');
  assert.equal(app.parseCallback(`https://app.example.com/cb?code=c1&state=${auth.state}&iss=https://b1.lc`, auth.state), 'c1');
  assert.throws(() => app.parseCallback(`https://app.example.com/cb?code=c1&state=nope`, auth.state), OAuthError);
  assert.throws(() => app.parseCallback(`https://app.example.com/cb?code=c1&state=${auth.state}&iss=https://evil.example`, auth.state), OAuthError);
  assert.throws(() => app.parseCallback(`https://app.example.com/cb?error=access_denied&state=${auth.state}`, auth.state), (e) => e.error === 'access_denied');
});

test('an in-flight 409 (Retry-After) is retried; a real conflict is not', async () => {
  const { f, calls } = fake((n) => (n === 1 ? json(409, { title: 'Request In Progress', status: 409 }, { 'retry-after': '1' }) : json(201, { success: true, data: { id: 3 }, meta: {} })));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  bn.sleep = async () => {};
  assert.equal((await bn.links.create({ url: 'https://example.com' })).id, 3);
  assert.equal(calls.length, 2);
  const taken = fake(() => json(409, { title: 'Code Taken', status: 409 }));
  const bn2 = new BNShortener({ apiKey: 'k', fetch: taken.f });
  await assert.rejects(bn2.links.create({ url: 'https://example.com', custom_code: 'abc' }), (e) => e.status === 409);
  assert.equal(taken.calls.length, 1);
});

test('a body that stalls after the headers times out', async () => {
  const f = async (url, init) => {
    const body = new ReadableStream({
      start(c) { init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const bn = new BNShortener({ apiKey: 'k', fetch: f, timeout: 100, maxRetries: 0 });
  await assert.rejects(bn.links.list(), (e) => e.name === 'APITimeoutError');
});

test('an aborted signal stops the call before anything is sent', async () => {
  const { f, calls } = fake(() => json(201, { success: true, data: {}, meta: {} }));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(bn.links.create({ url: 'https://example.com' }, { signal: ctrl.signal }));
  assert.equal(calls.length, 0);
});

test('a redirect is an error, not an empty file', async () => {
  const { f } = fake(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
  const bn = new BNShortener({ apiKey: 'k', fetch: f });
  await assert.rejects(bn.links.list(), (e) => e.status === 302);
});
