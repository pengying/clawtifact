// Local QA only: no Cloudflare and no real channel delivery.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ArtifactStore, DAY } from '../src/store.js';
import { createHandler } from '../src/http.js';
import { FeedbackBroker } from '../src/feedback.js';
const port = Number(process.env.PORT || 18948);
const origin = `http://127.0.0.1:${port}`;
mkdirSync('.local', { recursive: true });
const store = new ArtifactStore({ file: '.local/dev.sqlite' });
const sent = [];
const feedback = new FeedbackBroker({ system: {
  captureSessionEventTarget: async () => ({}),
  enqueueSessionEvent(text) {
    sent.push({ text }); writeFileSync('.local/dev-feedback.json', JSON.stringify(sent), { mode: 0o600 });
    return { accepted: Promise.resolve({ ok: true }), settled: new Promise(resolve => setTimeout(() => resolve({ status: 'completed', delivered: true }), 800)) };
  },
} });
const target = await feedback.capture({ agentId: 'demo', sessionKey: 'demo', deliveryContext: { channel: 'demo', to: 'local-only' } });
const urls = {};
for (const [format, content] of Object.entries({
  markdown: '# Feedback QA\n\nThis local demo never sends real messages. Select this sentence and add a comment.\n\n## Architecture\n\n```mermaid\nflowchart LR\n A[Artifact] --> B[Feedback] --> C[Discussion]\n```\n\n' + Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n\nA readable paragraph for scrolling and selection.`).join('\n\n'),
  html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;background:#101a17;color:#e0eee6;padding:28px}button{padding:12px}canvas{border:1px solid #9be0c0}</style></head><body><h1>Interactive feedback QA</h1><p>This local demo never sends real messages. Select this sentence.</p><button id="counter">Click count: 0</button><p><canvas id="chart" width="320" height="160"></canvas></p><script>let n=0;document.querySelector("#counter").onclick=e=>e.target.textContent="Click count: "+ ++n;let c=document.querySelector("canvas").getContext("2d");c.fillStyle="#75d5b0";c.fillRect(20,40,90,100);c.fillStyle="#b4a1f2";c.fillRect(150,10,90,130);</script><p style="margin-top:1000px">End of interactive page.</p></body></html>',
})) {
  const item = store.create({ title: `Feedback ${format} QA`, [format]: content, owner: 'demo' });
  feedback.bind(item.id, target, Date.now() + DAY);
  urls[format] = `${origin}/artifacts/${item.token}`;
}
writeFileSync('.local/demo-urls.json', JSON.stringify(urls), { mode: 0o600 });
const handler = createHandler({ store, origin, secure: false, feedback, onError: () => console.error('Local QA request failed') });
const server = createServer(handler);
server.listen(port, '127.0.0.1', () => console.log('Local QA ready on loopback; URLs saved in .local/demo-urls.json. Delivery is simulated.'));
function stop() { server.close(() => { feedback.clear(); store.close(); process.exit(); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
