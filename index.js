import { FeedbackBroker } from './src/feedback.js';
import { CloudflareSession } from './src/tunnel.js';
import { join } from 'node:path';
import { ArtifactStore, DAY, validateArtifact } from './src/store.js';
import { createHandler } from './src/http.js';

export function validateOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error('publicBaseUrl must be an HTTPS origin, with no credentials, path, query or fragment'); }
}
const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export default {
  id: 'artifacts', name: 'Review Artifacts',
  description: 'Explicitly requested, single-browser Markdown or interactive HTML review links.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const feedback = new FeedbackBroker({ system: api.runtime.system });
    const tunnel = config.cloudflare ? new CloudflareSession({ ...config.cloudflare, lifetimeMs: (config.cloudflare.lifetimeSeconds ?? 3600) * 1000 }) : null;
    const fixedOrigin = tunnel ? null : validateOrigin(config.publicBaseUrl);
    const exposure = () => tunnel ? tunnel.current() : { origin: fixedOrigin, expiresAt: null };
    let handlerOrigin;
    let store, handler, timer;
    const getStore = () => store ??= new ArtifactStore({ file: join(api.runtime.state.resolveStateDir(), 'artifacts', 'artifacts.sqlite') });
    api.registerTool(ctx => {
      if (!ctx.sessionKey) return null;
      const owner = ctx.sessionKey;
      return [{
        name: 'artifact_create', label: 'Create review artifact',
        description: 'Only when the user explicitly asks for a URL/link: create a private single-browser artifact. Choose the format and styling based on the task without asking the user to choose: Markdown for straightforward plans/notes/docs; self-contained HTML/CSS/JS for useful custom layouts or interaction. Supply exactly one of markdown or html. No injected branding/header/footer. Markdown supports tables, highlighted code and Mermaid fences, with an adaptive clean reading theme; raw HTML/images in Markdown are disabled. HTML is authored as a complete mobile-friendly document including viewport meta, inline CSS/JS, optional inline SVG or data images. A floating feedback overlay lets the claimed browser annotate text or regions and send a batch for discussion to this original conversation; feedback does not authorize automatic revisions. Feedback is unavailable on older artifacts after plugin reload; request a fresh artifact rather than changing destinations. HTML runs in an opaque-origin sandbox: no cookies/storage, remote libraries/assets, fetch/network, forms, frames, popups, workers or eval. Use vanilla JavaScript and inline SVG/canvas for interactive visuals. No automatic sharing. Return the URL to the user, never fetch/claim their link; use separate QA links. Claim/read windows up to 24h, capped by publicLinkExpiresAt in managed Cloudflare mode. Tell the user when public access closes; traffic never extends it.',
        parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, markdown: { type: 'string', minLength: 1, maxLength: 262144 }, html: { type: 'string', minLength: 1, maxLength: 262144 } }, required: ['title'], oneOf: [{ required: ['markdown'] }, { required: ['html'] }], additionalProperties: false },
        async execute(_callId, params) {
          validateArtifact({ ...params, owner });
          const target = await feedback.capture(ctx);
          const { origin, expiresAt } = tunnel ? await tunnel.ensure() : exposure();
          const item = getStore().create({ title: params.title, markdown: params.markdown, html: params.html, owner, expiresAt });
          feedback.bind(item.id, target, expiresAt ?? item.claimUntil + DAY);
          return result({ feedbackAvailable: feedback.available(item.id), id: item.id, url: `${origin}/artifacts/${item.token}`, claimExpiresAt: new Date(item.claimUntil).toISOString(), readingWindowHours: 24, publicLinkExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
        },
      }, {
        name: 'artifact_revoke', label: 'Revoke review artifact',
        description: 'Revoke an artifact created by this conversation, immediately removing its content and browser access. Other conversations cannot revoke it.',
        parameters: objectSchema({ id: { type: 'string', pattern: '^[a-f0-9]{32}$' } }),
        async execute(_callId, { id }) { const revoked = getStore().revoke(id, owner); if (revoked) feedback.remove(id); return result({ revoked }); },
      }];
    }, { names: ['artifact_create', 'artifact_revoke'], optional: true, workspaceAccess: false });
    api.registerHttpRoute({
      path: '/artifacts', match: 'prefix', auth: 'plugin',
      handler(req, res) {
        const live = exposure();
        if (!live) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found'); return true; }
        const origin = live.origin;
        if (origin !== handlerOrigin) { handler = undefined; handlerOrigin = origin; }
        handler ??= createHandler({ store: getStore(), origin, feedback, onError: () => api.logger.error('Artifact request failed (request and content omitted)') });
        return handler(req, res);
      },
    });
    api.registerService({
      id: 'artifacts-cleanup',
      start() {
        getStore().cleanup(); feedback.prune();
        clearInterval(timer);
        timer = setInterval(() => { try { getStore().cleanup(); feedback.prune(); } catch { api.logger.error('Artifact cleanup failed'); } }, Math.min(DAY, 300_000));
        timer.unref();
      },
      async stop() { clearInterval(timer); await tunnel?.close(); store?.close(); store = undefined; handler = undefined; feedback.clear(); },
    });
  },
};
