import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mod = await import('../index.js').catch(() => ({}));

test('plugin registers a lazy, session-scoped tool factory and lifecycle', async t => {
  assert.equal(typeof mod.default?.register, 'function', 'plugin entry is implemented');
  const dir = mkdtempSync(join(tmpdir(), 'art-plugin-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const registrations = {};
  const api = {
    pluginConfig: { publicBaseUrl: 'https://review.example.com' },
    runtime: { state: { resolveStateDir: () => dir } }, logger: { error() {} },
    registerTool(factory, options) { registrations.factory = factory; registrations.options = options; },
    registerHttpRoute(route) { registrations.route = route; },
    registerService(service) { registrations.service = service; },
  };
  mod.default.register(api);
  assert.equal(existsSync(join(dir, 'artifacts')), false, 'catalog inspection does not touch state');
  assert.equal(registrations.route.auth, 'plugin');
  assert.equal(registrations.route.match, 'prefix');
  assert.deepEqual(registrations.options.names, ['artifact_create', 'artifact_revoke']);
  assert.equal(registrations.options.workspaceAccess, false);
  const tools = registrations.factory({ sessionKey: 'session:a' });
  const created = await tools[0].execute('call', { title: 'Plan', markdown: '# Plan' });
  const result = created.details;
  assert.match(result.url, /^https:\/\/review\.example\.com\/artifacts\/[A-Za-z0-9_-]{43}$/);
  const other = registrations.factory({ sessionKey: 'session:b' });
  assert.equal((await other[1].execute('call', { id: result.id })).details.revoked, false);
  assert.equal((await tools[1].execute('call', { id: result.id })).details.revoked, true);
  assert.equal(registrations.factory({}), null, 'no ambient session, no publication');
  await assert.rejects(tools[0].execute('call', { title: 'Plan', markdown: '' }), /Markdown/);
  await registrations.service.stop();
});

test('plugin requires an explicit HTTPS origin', () => {
  assert.equal(typeof mod.validateOrigin, 'function', 'config validation is implemented');
  for (const value of ['', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/a', 'https://example.com?q=x']) {
    assert.throws(() => mod.validateOrigin(value), /HTTPS origin/);
  }
  assert.equal(mod.validateOrigin('https://example.com/'), 'https://example.com');
});

test('managed Cloudflare mode stays closed on startup and rejects invalid content without exposure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-managed-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const reg = {};
  mod.default.register({ pluginConfig: { cloudflare: { binary: '/opt/cloudflared', proxyUrl: 'http://127.0.0.1:19447' } }, runtime: { state: { resolveStateDir: () => dir } }, logger: { error() {} }, registerTool: f => reg.factory = f, registerHttpRoute: r => reg.route = r, registerService: s => reg.service = s });
  await reg.service.start();
  t.after(() => reg.service.stop());
  const res = { setHeader() {}, writeHead(code) { this.code = code }, end() {} };
  await reg.route.handler({ url: '/artifacts/'+'x'.repeat(43), method: 'GET', headers: {} }, res);
  assert.equal(res.code, 404, 'HTTP requests cannot start a tunnel');
  const create = reg.factory({ sessionKey: 'a' })[0];
  await assert.rejects(create.execute('x', { title: 'Invalid', markdown: '' }), /Markdown/);
});

test('artifact_create reports feedback unavailable when the host returns no opaque authority', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-no-target-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const reg = {};
  let captures = 0;
  mod.default.register({
    pluginConfig: { publicBaseUrl: 'https://review.example.com' },
    runtime: { state: { resolveStateDir: () => dir }, system: {
      async captureSessionEventTarget() { captures++; return undefined; },
      enqueueSessionEvent() { assert.fail('feedback has no retained authority'); },
      enqueueSystemEvent() { assert.fail('no passive event fallback'); },
    } },
    logger: { error() {} },
    registerTool: factory => reg.factory = factory,
    registerHttpRoute: route => reg.route = route,
    registerService: service => reg.service = service,
  });
  t.after(() => reg.service.stop());
  const created = await reg.factory({ agentId: 'main', sessionKey: 'original' })[0].execute('call', { title: 'Plan', markdown: '# Plan' });
  assert.equal(created.details.feedbackAvailable, false);
  assert.equal(captures, 1);
  assert.match(created.details.url, /^https:\/\/review\.example\.com\/artifacts\//);
});
