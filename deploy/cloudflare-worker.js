/**
 * Cloudflare Worker: serves the Vault website at your own domain (ericmay.org).
 *
 * Every request for the domain is passed to the Azure App Service and the answer is sent
 * back unchanged (pages, redirects, cookies). Azure only sees its own *.azurewebsites.net
 * address, which is why this works on the free App Service plan.
 *
 * Worker settings (Settings → Variables and Secrets):
 *   ORIGIN_HOST   text    hobbysite-6xrma0.azurewebsites.net
 *   PROXY_SECRET  secret  the same value as the App Service setting PROXY_SECRET
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = `https://${env.ORIGIN_HOST}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete('host'); // Azure must see its own host name
    headers.set('X-Proxy-Secret', env.PROXY_SECRET);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Client-IP', request.headers.get('CF-Connecting-IP') || '');

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    return fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined, // forms and CSV uploads (≤ 20 MB)
      redirect: 'manual', // pass the site's own redirects (e.g. after a form) to the browser
    });
  },
};
