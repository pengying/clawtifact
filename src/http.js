import { readFileSync } from 'node:fs';
import { landing, reader } from './render.js';
import { secret, validToken } from './store.js';

const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
const notFound = res => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };

export function createHandler({ store, origin, secure = true, onError = () => {} }) {
  const assets = new Map();
  function cookie(name, value, path) {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      const path = new URL(req.url, origin).pathname;
      if (/^\/artifacts\/assets\/(reader\.js|claim\.js|style\.css)$/.test(path) && ['GET', 'HEAD'].includes(req.method)) {
        const name = path.split('/').at(-1);
        if (!assets.has(name)) assets.set(name, readFileSync(new URL(`../dist/${name}`, import.meta.url)));
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : assets.get(name));
        return true;
      }
      const match = /^\/artifacts\/([A-Za-z0-9_-]{43})(\/claim)?$/.exec(path);
      if (!match) { notFound(res); return true; }
      const [, token, claimPath] = match;
      const documentPath = `/artifacts/${token}`;
      const current = store.get(token, cookieValue(req, 'oc_art_session'));
      if (!current) { notFound(res); return true; }
      if (claimPath && req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { notFound(res); return true; }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 2048) { notFound(res); return true; }
        }
        const nonce = new URLSearchParams(body).get('nonce');
        if (!validToken(nonce) || nonce !== cookieValue(req, 'oc_art_claim')) { notFound(res); return true; }
        const session = store.claim(token);
        if (!session) { notFound(res); return true; }
        res.setHeader('Set-Cookie', cookie('oc_art_session', session, documentPath));
        res.writeHead(303, { Location: documentPath });
        res.end();
        return true;
      }
      if (claimPath || !['GET', 'HEAD'].includes(req.method)) { notFound(res); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.method === 'HEAD') { res.end(); return true; }
      if (current.kind === 'unclaimed') {
        const existing = cookieValue(req, 'oc_art_claim');
        const nonce = validToken(existing) ? existing : secret();
        res.setHeader('Set-Cookie', cookie('oc_art_claim', nonce, documentPath));
        res.end(landing(documentPath, nonce));
      } else {
        if (current.format === 'html') {
          // An opaque origin prevents authored JS reading cookies, storage or Gateway DOM.
          // No external resources, network APIs, forms, frames, workers or eval.
          res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'");
          res.setHeader('Referrer-Policy', 'no-referrer');
        }
        res.end(reader(current));
      }
    } catch (error) {
      onError(error);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Unable to load artifact'); }
      else res.end();
    }
    return true;
  };
}
