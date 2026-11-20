/**
 * Serving the site at a custom domain through a Cloudflare Worker (see deploy/cloudflare-worker.js).
 *
 * The Worker forwards every request for PUBLIC_HOST (e.g. ericmay.org) to this App Service
 * and adds X-Proxy-Secret. With PUBLIC_HOST and PROXY_SECRET both set:
 *   - requests carrying the right secret are trusted: the visitor's IP comes from
 *     X-Client-IP (Cloudflare's CF-Connecting-IP), so the login rate limit is per visitor;
 *   - anything else (someone opening the *.azurewebsites.net address) is redirected to
 *     https://PUBLIC_HOST, except /healthz, which the deploy workflow checks.
 * With either setting missing, nothing changes.
 */
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function proxyMiddleware({ publicHost = process.env.PUBLIC_HOST, secret = process.env.PROXY_SECRET } = {}) {
  const enabled = !!(publicHost && secret);
  const want = enabled ? digest(secret) : null;
  return (req, res, next) => {
    const given = req.get('x-proxy-secret');
    req.viaProxy = enabled && !!given && crypto.timingSafeEqual(digest(given), want);
    req.clientIp = (req.viaProxy && req.get('x-client-ip')) || req.ip;
    if (enabled && !req.viaProxy && req.path !== '/healthz') {
      return res.redirect(301, `https://${publicHost}${req.originalUrl}`);
    }
    next();
  };
}

module.exports = { proxyMiddleware };
