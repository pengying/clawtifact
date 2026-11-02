import { readFileSync } from 'node:fs';
import { landing, framedReader, feedbackHost } from './render.js';
import { secret, validToken } from './store.js';
import { FeedbackError } from './feedback.js';

const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
const notFound = res => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > max) throw new FeedbackError('Request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function createHandler({ store, origin, secure = true, feedback, onError = () => {} }) {
  const assets = new Map();
  function cookie(name, value, path) { return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`; }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      const path = new URL(req.url, origin).pathname;
      if (/^\/artifacts\/assets\/(reader\.js|claim\.js|style\.css|feedback\.js|feedback\.css|bridge\.js)$/.test(path) && ['GET', 'HEAD'].includes(req.method)) {
        const name = path.split('/').at(-1);
        if (!assets.has(name)) assets.set(name, readFileSync(new URL(`../dist/${name}`, import.meta.url)));
        // Public immutable code only. Opaque content frames need module CORS.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : assets.get(name)); return true;
      }
      const match = /^\/artifacts\/([A-Za-z0-9_-]{43})(?:\/(claim|content|feedback))?$/.exec(path);
      if (!match) { notFound(res); return true; }
      const [, token, action] = match;
      const documentPath = `/artifacts/${token}`;
      const current = store.get(token, cookieValue(req, 'oc_art_session'));
      if (!current) { notFound(res); return true; }
      if (action === 'claim' && req.method === 'POST') {
        if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { notFound(res); return true; }
        const body = await readBody(req, 2048);
        const nonce = new URLSearchParams(body).get('nonce');
        if (!validToken(nonce) || nonce !== cookieValue(req, 'oc_art_claim')) { notFound(res); return true; }
        const session = store.claim(token);
        if (!session) { notFound(res); return true; }
        res.setHeader('Set-Cookie', cookie('oc_art_session', session, documentPath));
        res.writeHead(303, { Location: documentPath }); res.end(); return true;
      }
      if (action === 'feedback') {
        if (current.kind !== 'claimed') { notFound(res); return true; }
        if (req.method === 'GET') { json(res, 200, feedback?.status(current.id) ?? { enabled: false, batches: [] }); return true; }
        if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') { notFound(res); return true; }
        let data;
        try { data = JSON.parse(await readBody(req, 32768)); } catch (e) { throw e instanceof FeedbackError ? e : new FeedbackError('Invalid JSON'); }
        const csrfCookie = cookieValue(req, 'oc_art_feedback');
        if (!validToken(data?.csrf) || !validToken(csrfCookie) || data.csrf !== csrfCookie) { notFound(res); return true; }
        if (!feedback) throw new FeedbackError('Feedback unavailable; request a fresh artifact', 503);
        const { csrf, ...payload } = data;
        json(res, 202, feedback.submit(current.id, payload, current)); return true;
      }
      if (action === 'claim' || !['GET', 'HEAD'].includes(req.method) || (action && current.kind !== 'claimed')) { notFound(res); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.method === 'HEAD') { res.end(); return true; }
      if (current.kind === 'unclaimed') {
        const existing = cookieValue(req, 'oc_art_claim'); const nonce = validToken(existing) ? existing : secret();
        res.setHeader('Set-Cookie', cookie('oc_art_claim', nonce, documentPath));
        res.end(landing(documentPath, nonce));
      } else if (action === 'content') {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        const bridge = `${origin}/artifacts/assets/bridge.js`;
        res.setHeader('Content-Security-Policy', current.format === 'html'
          ? `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${bridge}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'`
          : "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.end(framedReader(current, origin));
      } else {
        const existing = cookieValue(req, 'oc_art_feedback'); const csrf = validToken(existing) ? existing : secret();
        res.setHeader('Set-Cookie', cookie('oc_art_feedback', csrf, documentPath));
        res.end(feedbackHost({ path: documentPath, artifactId: current.id, csrf, enabled: feedback?.available(current.id) ?? false }));
      }
    } catch (error) {
      if (error instanceof FeedbackError && !res.headersSent) { json(res, error.status, { error: error.message }); }
      else {
        onError(error);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Unable to load artifact'); }
        else res.end();
      }
    }
    return true;
  };
}
