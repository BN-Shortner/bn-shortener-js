# @bn-shortner/shortener (TypeScript / JavaScript)

Official client for the [BN Shortener API](https://b1.lc/docs/) (b1.lc): short links, QR codes, bio pages,
analytics, Launch Check, webhooks and OAuth. Typed from the OpenAPI spec, no dependencies. Node 20+, Deno, Bun,
Cloudflare Workers and browsers.

```bash
npm install @bn-shortner/shortener
```

## Quick start

```ts
import { BNShortener } from '@bn-shortner/shortener';

const bn = new BNShortener({ apiKey: process.env.BN_API_KEY });

const link = await bn.links.create({ url: 'https://example.com/spring-sale', title: 'Spring sale' });
console.log(link.short_url); // https://b1.lc/AbC9

const stats = await bn.links.stats(link.id!, { period: '30d' });
console.log(stats.summary?.total_clicks);

for await (const l of bn.paginate(bn.links.list, { search: 'sale' })) console.log(l.short_code);
```

Create an API key in the dashboard: **API Portal → API keys**. Do not put an API key in a public web page;
browser apps should use OAuth (below) so each person signs in with their own account.

## Resources

`bn.links`, `bn.qrCodes`, `bn.bioPages`, `bn.webhooks`, `bn.launchCheck`, `bn.security`, `bn.messaging`,
`bn.apiKeys`, `bn.account`, `bn.appLinks`, `bn.system`. Every method's doc comment names its endpoint and the
permission it needs. Methods resolve to the response's `data`; list methods to a `Page` (iterable, `.data`,
`.pagination`, `.nextPage()`); files to a `BinaryResult` (`.data` Uint8Array, `.contentType`, `.text()`).

```ts
const qr = await bn.qrCodes.create({ name: 'Menu', content: { url: 'https://example.com/menu' } });
const svg = await bn.qrCodes.image(qr.id!, { format: 'svg', size: 1000 });
```

Live clicks: `for await (const click of bn.links.streamClicks(linkId)) { ... }`.

## Errors

```ts
import { ValidationError, APIError } from '@bn-shortner/shortener';

try {
  await bn.links.create({ url: 'not a url' });
} catch (e) {
  if (e instanceof ValidationError) console.log(e.errors); // [{ field: 'url', code, message }]
  else if (e instanceof APIError) console.log(e.status, e.type, e.detail, e.requestId);
}
```

Connection errors, timeouts, 408, 429 and 5xx are retried (`maxRetries: 2`, waiting as long as `Retry-After`
says). Every write carries an `Idempotency-Key`, so a retry after a lost answer never creates a second link.

## Apps that act for other people (OAuth 2.1)

```ts
import { BNShortener, OAuthClient, TokenSession } from '@bn-shortner/shortener';

const app = new OAuthClient({ clientId: 'bnc_...', redirectUri: 'https://example.com/callback' });
const auth = await app.authorizationUrl({ scope: ['read', 'write'] }); // keep auth.state + auth.codeVerifier
// send the person to auth.url; b1.lc sends them back to your redirect URI
const code = app.parseCallback(callbackUrl, auth.state);
const token = await app.exchangeCode(code, auth.codeVerifier);

const bn = new BNShortener({ oauth: new TokenSession(app, token, { onRefresh: saveToken }) });
```

Command-line tools: `const device = await app.startDeviceFlow({ scope: ['read'] })`, show
`device.verification_uri` + `device.user_code`, then `await app.waitForDevice(device)`.

## Webhooks

```ts
import { webhooks } from '@bn-shortner/shortener';

const event = await webhooks.constructEvent(rawBody, req.headers, process.env.BN_WEBHOOK_SECRET!);
```

Pass the raw body (string or bytes) before JSON parsing. Signatures older than 5 minutes are refused.

## Options

`new BNShortener({ apiKey, accessToken, oauth, baseUrl, timeout, maxRetries, clientName, defaultHeaders, fetch })`.
`clientName` names your integration in the account's usage. `bn.lastResponse` has the status, request id and
rate limit of the latest call. `bn.request({ method, path, query, body })` calls any endpoint.

## License

MIT
