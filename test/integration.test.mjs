// Against a running API (tests/test_sdk.py starts one on the test database and sets the BN_TEST_* variables).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BNShortener, OAuthClient, TokenSession, NotFoundError, PermissionDeniedError } from '../dist/esm/index.js';

const E = process.env;
const live = Boolean(E.BN_TEST_API_BASE);

test('links, pages, errors and QR files against the API', { skip: !live && 'no BN_TEST_API_BASE' }, async () => {
  const bn = new BNShortener({ apiKey: E.BN_TEST_API_KEY, baseUrl: E.BN_TEST_API_BASE });
  const link = await bn.links.create({ url: 'https://example.com/from-ts', title: 'TS' });
  assert.match(link.short_url, /^https:\/\/b1\.lc\//);
  assert.equal((await bn.links.get(link.id)).title, 'TS');
  assert.equal((await bn.links.update(link.id, { title: 'TS 2' })).title, 'TS 2');
  await bn.links.create({ url: 'https://example.com/from-ts/2' });
  const all = [];
  for await (const l of bn.paginate(bn.links.list, { per_page: 1 })) all.push(l.id);
  assert.ok(all.length >= 2 && all.includes(link.id));
  await assert.rejects(bn.links.get(999999999), NotFoundError);
  await bn.links.delete(link.id);
  const qr = await bn.qrCodes.create({ name: 'TS QR', content: { url: 'https://example.com/qr' } });
  const svg = await bn.qrCodes.image(qr.id, { format: 'svg', size: 200 });
  assert.equal(svg.contentType, 'image/svg+xml');
  assert.match(svg.text(), /<svg|<\?xml/);
  const ro = new BNShortener({ apiKey: E.BN_TEST_API_KEY, baseUrl: E.BN_TEST_API_BASE, clientName: 'ts-test/1' });
  assert.ok(Array.isArray((await ro.links.list()).data));
});

test('OAuth: consent, code exchange, API calls with the token, refresh, revoke', { skip: !live && 'no BN_TEST_API_BASE' }, async () => {
  const redirectUri = 'http://127.0.0.1/cb';
  const app = new OAuthClient({ clientId: E.BN_TEST_OAUTH_CLIENT, redirectUri, issuer: E.BN_TEST_ISSUER });
  const auth = await app.authorizationUrl({ scope: ['read', 'write'] });
  // what the person's browser does on the consent page
  const cookie = { cookie: `token=${E.BN_TEST_USER_TOKEN}` };
  const page = await (await fetch(auth.url.replace('https://b1.lc', E.BN_TEST_ISSUER), { headers: cookie })).text();
  const fields = Object.fromEntries([...page.matchAll(/<input type='hidden' name='([^']+)' value='([^']*)'/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const allow = await fetch(`${E.BN_TEST_ISSUER}/api/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision: 'allow' }).toString(),
  });
  assert.equal(allow.status, 302);
  const location = allow.headers.get('location');
  // the issuer in the callback is the configured public one (https://b1.lc), not this test server
  const code = new URL(location).searchParams.get('code');
  assert.ok(code && new URL(location).searchParams.get('state') === auth.state);
  const token = await app.exchangeCode(code, auth.codeVerifier);
  assert.match(token.access_token, /^bn_oat_/);

  const saved = [];
  const session = new TokenSession(app, token, { onRefresh: (t) => void saved.push(t) });
  const bn = new BNShortener({ oauth: session, baseUrl: E.BN_TEST_API_BASE });
  assert.ok((await bn.links.create({ url: 'https://example.com/ts-oauth' })).id);
  await assert.rejects(bn.links.delete(1), PermissionDeniedError);
  session.token.expires_at = 0;
  await bn.links.list();
  assert.equal(saved.length, 1);
  assert.notEqual(saved[0].refresh_token, token.refresh_token);
  await app.revoke(session.token.refresh_token);
});
