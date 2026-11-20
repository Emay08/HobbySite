const test = require('node:test');
const assert = require('node:assert');
const { proxyMiddleware } = require('../lib/proxy');

const run = (mw, { path = '/mtgo', headers = {}, ip = '10.0.0.1' } = {}) => {
  const req = { path, originalUrl: path + '?x=1', ip, get: (h) => headers[h.toLowerCase()] };
  let redirected = null;
  let nexted = false;
  mw(req, { redirect: (code, url) => (redirected = { code, url }) }, () => (nexted = true));
  return { req, redirected, nexted };
};

test('without settings nothing changes', () => {
  const r = run(proxyMiddleware({ publicHost: '', secret: '' }), { headers: { 'x-client-ip': '1.2.3.4' } });
  assert.ok(r.nexted);
  assert.equal(r.req.clientIp, '10.0.0.1');
});

test('worker requests are trusted, direct ones go to the custom domain', () => {
  const mw = proxyMiddleware({ publicHost: 'ericmay.org', secret: 's3cret' });
  const ok = run(mw, { headers: { 'x-proxy-secret': 's3cret', 'x-client-ip': '1.2.3.4' } });
  assert.ok(ok.nexted);
  assert.equal(ok.req.clientIp, '1.2.3.4');

  const direct = run(mw, { headers: { 'x-client-ip': '6.6.6.6' } });
  assert.deepEqual(direct.redirected, { code: 301, url: 'https://ericmay.org/mtgo?x=1' });

  const wrong = run(mw, { headers: { 'x-proxy-secret': 'nope', 'x-client-ip': '6.6.6.6' } });
  assert.ok(wrong.redirected);

  const health = run(mw, { path: '/healthz' });
  assert.ok(health.nexted);
});
