import { test } from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../src/feedback.js').catch(() => ({}));
const id = '12345678-1234-4234-8234-123456789abc';
const comment = { text: 'Please explain this assumption', anchor: { type: 'text', quote: 'Build the API', prefix: '', suffix: '' } };
const payload = () => ({ id, comments: [structuredClone(comment)] });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  assert.equal(typeof mod.FeedbackBroker, 'function', 'feedback broker is implemented');
  const settled = defer(); const accepted = defer(); const calls = [];
  const target = {};
  const system = { captureSessionEventTarget: async (...args) => { calls.push(['capture', ...args]); return target; }, enqueueSessionEvent(text, options) { calls.push(['enqueue', text, options]); return { accepted: accepted.promise, settled: settled.promise, cancel() {} }; } };
  const broker = new mod.FeedbackBroker({ system });
  return { broker, calls, target, accepted, settled };
}
test('feedback validates bounded comments and anchors; routing is never accepted from the browser', () => {
  assert.equal(typeof mod.validateFeedback, 'function', 'feedback validation exists');
  assert.deepEqual(mod.validateFeedback(payload()), payload());
  for (const bad of [
    { ...payload(), channel: 'another-channel' }, { ...payload(), id: 'bad' },
    { id, comments: [] }, { id, comments: Array(21).fill(comment) },
    { id, comments: [{ ...comment, text: 'x'.repeat(1001) }] },
    { id, comments: [{ text: 'x', anchor: { type: 'text', quote: 'x'.repeat(2001) } }] },
    { id, comments: [{ text: 'x', anchor: { type: 'region', x: 0.9, y: 0, width: 0.5, height: 0.1, scrollX: 0, scrollY: 0, viewportWidth: 100, viewportHeight: 100 } }] },
  ]) assert.throws(() => mod.validateFeedback(bad));
});
test('feedback binds original channel/thread and queues each immutable batch once', async () => {
  const f = fixture();
  const captured = await f.broker.capture({ agentId: 'main', sessionKey: 'agent:main:original', deliveryContext: { channel: 'telegram', to: 'original', threadId: 'thread-one' } });
  f.broker.bind('artifact-one', captured, Date.now() + 10000);
  assert.equal(f.broker.available('artifact-one'), true);
  const a = f.broker.submit('artifact-one', payload(), { title: 'Plan' });
  const b = f.broker.submit('artifact-one', payload(), { title: 'Plan' });
  assert.equal(a.status, 'queued'); assert.deepEqual(a, b);
  const calls = f.calls.filter(x => x[0] === 'enqueue'); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].expectedTarget, f.target);
  assert.deepEqual(calls[0][2].deliveryContext, { channel: 'telegram', to: 'original', threadId: 'thread-one' });
  assert.match(calls[0][1], /discussion/i); assert.match(calls[0][1], /untrusted/i);
  assert.match(calls[0][1], /Please explain this assumption/);
  assert.throws(() => f.broker.submit('artifact-one', { id, comments: [{ text: 'Changed', anchor: { type: 'general' } }] }, { title: 'Plan' }), /different/i);
  f.accepted.resolve({ ok: true }); f.settled.resolve({ status: 'completed', delivered: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.status('artifact-one').batches[0].status, 'delivered');
});
test('failure or ambiguous delivery is retained without duplicate dispatch; missing/reset bindings fail closed', async () => {
  const f = fixture();
  assert.equal(f.broker.available('missing'), false);
  assert.throws(() => f.broker.submit('missing', payload(), { title: 'Plan' }), /unavailable/i);
  const capture = await f.broker.capture({ agentId: 'main', sessionKey: 'source' });
  f.broker.bind('one', capture, Date.now() + 10000);
  f.broker.submit('one', payload(), { title: 'Plan' });
  f.accepted.resolve({ ok: true }); f.settled.resolve({ status: 'failed', delivered: false, deliveryAmbiguous: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.status('one').batches[0].status, 'uncertain');
  assert.equal(f.broker.submit('one', payload(), { title: 'Plan' }).status, 'uncertain');
  assert.equal(f.calls.filter(x => x[0] === 'enqueue').length, 1);
  f.broker.clear(); assert.equal(f.broker.available('one'), false);
});
test('unsupported SDK, expired bindings and batch flooding do not dispatch', async () => {
  const f = fixture();
  assert.equal(await new mod.FeedbackBroker({}).capture({ agentId: 'main', sessionKey: 'x' }), null);
  const capture = await f.broker.capture({ agentId: 'main', sessionKey: 'source' });
  f.broker.bind('expired', capture, Date.now() - 1);
  assert.equal(f.broker.available('expired'), false);
  f.broker.bind('one', capture, Date.now() + 10000);
  for (let n = 0; n < 10; n++) f.broker.submit('one', { ...payload(), id: `12345678-1234-4234-8234-${String(n).padStart(12, '0')}` }, { title: 'Plan' });
  assert.throws(() => f.broker.submit('one', payload(), { title: 'Plan' }), /limit/i);
  f.accepted.resolve({ ok: false, error: 'reset' }); f.settled.resolve({ status: 'cancelled', delivered: false });
});

test('region feedback distinguishes unavailable scroll data from known coordinates', () => {
  const anchor = { type: 'region', x: 0.1, y: 0.2, width: 0.4, height: 0.3, scrollX: 0, scrollY: 1500, viewportWidth: 900, viewportHeight: 700, scrollKnown: true };
  assert.equal(mod.validateFeedback({ id, comments: [{ text: 'This chart', anchor }] }).comments[0].anchor.scrollKnown, true);
  const { scrollKnown, ...unknown } = anchor;
  assert.equal(mod.validateFeedback({ id, comments: [{ text: 'This chart', anchor: unknown }] }).comments[0].anchor.scrollKnown, false);
  assert.throws(() => mod.validateFeedback({ id, comments: [{ text: 'This chart', anchor: { ...anchor, scrollKnown: 'yes' } }] }));
});
