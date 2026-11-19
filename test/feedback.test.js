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

test('a batch delivers each selection reference together and explains the limits of region-only context', async () => {
  const f = fixture();
  const captured = await f.broker.capture({ agentId: 'main', sessionKey: 'original', deliveryContext: { channel: 'telegram', to: 'original', threadId: 'original-thread' } });
  f.broker.bind('artifact-batch', captured, Date.now() + 10000);
  const region = { text: 'The chart is hard to read', anchor: { type: 'region', x: .1, y: .2, width: .4, height: .3, scrollX: 0, scrollY: 250, viewportWidth: 800, viewportHeight: 600, scrollKnown: true } };
  f.broker.submit('artifact-batch', { id, comments: [comment, region] }, { title: 'Design' });
  const events = f.calls.filter(call => call[0] === 'enqueue');
  assert.equal(events.length, 1);
  assert.equal(events[0][2].expectedTarget, f.target);
  assert.match(events[0][1], /Comment numbers follow array order/i);
  assert.match(events[0][1], /not screenshots/i);
  assert.deepEqual(JSON.parse(events[0][1].split('\n\n')[1]).comments, [comment, region]);
  f.accepted.resolve({ ok: true }); f.settled.resolve({ delivered: true });
});

test('image feedback is read as real image content only by the exact original session incarnation', async () => {
  const f = fixture(), imageId = 'a'.repeat(32);
  const images = { available: () => true, get: (artifactId, id) => artifactId === 'one' && id === imageId ? { mimeType: 'image/jpeg', bytes: Buffer.from([255,216,255,217]) } : null, remove() {} };
  const broker = new mod.FeedbackBroker({ system: f.broker.system, images });
  const ctx = { agentId: 'main', sessionKey: 'original', sessionId: 'incarnation-a', deliveryContext: { channel: 'telegram', to: 'original', accountId: 'default', threadId: 'one' }, assertInvocationCurrent() {} };
  broker.bind('one', await broker.capture(ctx), Date.now() + 10000);
  broker.submit('one', { id, comments: [{ ...comment, imageId }] }, { title: 'Image plan' });
  assert.equal(typeof broker.readBatch, 'function');
  const result = broker.readBatch(ctx, 'one', id);
  const image = result.content.find(part => part.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.data, '/9j/2Q==');
  assert.match(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), /Comment #1/);
  assert.throws(() => broker.readBatch({ ...ctx, sessionId: 'replacement' }, 'one', id));
  assert.throws(() => broker.readBatch({ ...ctx, sessionKey: 'other' }, 'one', id));
  assert.throws(() => broker.readBatch({ ...ctx, deliveryContext: { ...ctx.deliveryContext, threadId: 'other' } }, 'one', id));
  assert.throws(() => broker.readBatch({ ...ctx, assertInvocationCurrent() { throw new Error('retired invocation'); } }, 'one', id), /retired/);
  assert.throws(() => broker.submit('one', { id: '22345678-1234-4234-8234-123456789abc', comments: [{ ...comment, imageId: 'b'.repeat(32) }] }, { title: 'Plan' }), /screenshot/i);
  f.accepted.resolve({ ok: true }); f.settled.resolve({ delivered: true });
});

test('a claimed read window can shorten but never extend the retained discussion deadline', async () => {
  const f = fixture();
  f.broker.bind('one', await f.broker.capture({ agentId: 'main', sessionKey: 'source' }), Date.now() + 10000);
  assert.equal(typeof f.broker.capExpiry, 'function');
  const original = f.broker.routes.get('one').expiresAt;
  f.broker.capExpiry('one', original + 100000); assert.equal(f.broker.routes.get('one').expiresAt, original);
  f.broker.capExpiry('one', original - 5000); assert.equal(f.broker.routes.get('one').expiresAt, original - 5000);
  f.broker.capExpiry('one', Date.now() - 1); assert.equal(f.broker.available('one'), false);
});

test('absent or invalid opaque capture authority never enables or dispatches feedback', async () => {
  for (const expectedTarget of [undefined, null, false, 0, '', 'copied-token', []]) {
    let dispatches = 0;
    const broker = new mod.FeedbackBroker({ system: {
      captureSessionEventTarget: async () => expectedTarget,
      enqueueSessionEvent() { dispatches++; throw new Error('must not dispatch'); },
      enqueueSystemEvent() { assert.fail('passive system events cannot replace captured authority'); },
    } });
    const captured = await broker.capture({ agentId: 'main', sessionKey: 'original' });
    assert.equal(captured, null, `reject missing/invalid target ${String(expectedTarget)}`);
    broker.bind('artifact', captured, Date.now() + 10000);
    assert.equal(broker.available('artifact'), false);
    assert.throws(() => broker.submit('artifact', payload(), { title: 'Plan' }), /unavailable/i);
    assert.equal(dispatches, 0);
  }
});

test('captured authority and original route remain immutable until dispatch', async () => {
  const f = fixture();
  const deliveryContext = { channel: 'telegram', to: 'original', threadId: 'original-thread' };
  const captured = await f.broker.capture({ agentId: 'main', sessionKey: 'original', deliveryContext });
  assert.throws(() => { captured.expectedTarget = undefined; }, TypeError);
  assert.throws(() => { captured.deliveryContext.threadId = 'replacement'; }, TypeError);
  deliveryContext.threadId = 'changed-later';
  f.broker.bind('artifact', captured, Date.now() + 10000);
  f.broker.submit('artifact', payload(), { title: 'Plan' });
  const [, , options] = f.calls.find(x => x[0] === 'enqueue');
  assert.equal(options.expectedTarget, f.target, 'pass the original opaque handle by identity');
  assert.equal(options.deliveryContext.threadId, 'original-thread');
  assert.equal('createIfMissing' in options, false, 'completion cannot initialize replacement ingress');
  f.accepted.resolve({ ok: true }); f.settled.resolve({ status: 'completed', delivered: true });
});

test('retired original authority fails without recapture or another dispatch path', async () => {
  let active = true; let captures = 0; let dispatches = 0;
  const expectedTarget = Object.freeze({});
  const broker = new mod.FeedbackBroker({ system: {
    async captureSessionEventTarget() { captures++; return expectedTarget; },
    enqueueSessionEvent(_message, options) {
      dispatches++;
      assert.equal(options.expectedTarget, expectedTarget);
      if (!active) throw new Error('retired owner');
      assert.fail('test revokes authority before dispatch');
    },
    enqueueSystemEvent() { assert.fail('no route fallback'); },
  } });
  broker.bind('artifact', await broker.capture({ agentId: 'main', sessionKey: 'original' }), Date.now() + 10000);
  active = false;
  assert.equal(broker.submit('artifact', payload(), { title: 'Plan' }).status, 'failed');
  assert.equal(broker.submit('artifact', payload(), { title: 'Plan' }).status, 'failed');
  assert.equal(captures, 1); assert.equal(dispatches, 1);
  broker.clear();
  assert.throws(() => broker.submit('artifact', payload(), { title: 'Plan' }), /unavailable/i);
  assert.equal(captures, 1); assert.equal(dispatches, 1);
});

test('binding rejects a route without retained opaque authority', () => {
  const { broker } = fixture();
  broker.bind('artifact', { agentId: 'main', sessionKey: 'original' }, Date.now() + 10000);
  assert.equal(broker.available('artifact'), false);
  assert.throws(() => broker.submit('artifact', payload(), { title: 'Plan' }), /unavailable/i);
});

test('completed work without native message-tool delivery accounting is unconfirmed, not a definite failure', async () => {
  const f=fixture();f.broker.bind('one',await f.broker.capture({agentId:'main',sessionKey:'original'}),Date.now()+10000);
  f.broker.submit('one',payload(),{title:'Plan'});f.accepted.resolve({ok:true});f.settled.resolve({status:'completed',executionStarted:true,delivered:false,deliveryAttempted:false});await new Promise(r=>setImmediate(r));
  assert.equal(f.broker.status('one').batches[0].status,'uncertain');
  f.broker.submit('one',payload(),{title:'Plan'});assert.equal(f.calls.filter(c=>c[0]==='enqueue').length,1,'never resend a potentially delivered batch');
});

test('exact original-session read acknowledges agent receipt without claiming channel delivery or being overwritten', async () => {
  for(const readFirst of [false,true]) {
    const f=fixture(),ctx={agentId:'main',sessionKey:'original',sessionId:'incarnation',deliveryContext:{channel:'telegram',to:'original',threadId:'one'},assertInvocationCurrent(){}};
    f.broker.bind('one',await f.broker.capture(ctx),Date.now()+10000);f.broker.submit('one',payload(),{title:'Plan'});
    assert.throws(()=>f.broker.readBatch({...ctx,sessionId:'other'},'one',id));assert.equal(f.broker.status('one').batches[0].status,'queued');
    if(readFirst)f.broker.readBatch(ctx,'one',id);
    f.accepted.resolve({ok:true});f.settled.resolve({status:'completed',executionStarted:true,delivered:false,deliveryAttempted:false});await new Promise(r=>setImmediate(r));
    if(!readFirst)f.broker.readBatch(ctx,'one',id);
    assert.deepEqual(f.broker.status('one').batches[0],{batchId:id,status:'received',deliveryStatus:'uncertain'});
    assert.equal(f.broker.submit('one',payload(),{title:'Plan'}).status,'received');assert.equal(f.calls.filter(c=>c[0]==='enqueue').length,1);
    f.broker.readBatch(ctx,'one',id);assert.equal(f.calls.filter(c=>c[0]==='enqueue').length,1,'reading acknowledges receipt, never sends a mirror');
  }
});

test('receipt acknowledgement rechecks current authority and never treats an unauthorized read as received', async()=>{
  const f=fixture();let assertions=0;
  const ctx={agentId:'main',sessionKey:'original',sessionId:'incarnation',deliveryContext:{channel:'telegram',to:'original',threadId:'one'},assertInvocationCurrent(){if(++assertions===2)throw new Error('retired during read');}};
  f.broker.bind('one',await f.broker.capture(ctx),Date.now()+10000);f.broker.submit('one',payload(),{title:'Plan'});
  assert.throws(()=>f.broker.readBatch(ctx,'one',id),/retired during read/);assert.equal(f.broker.status('one').batches[0].status,'queued');
  f.accepted.resolve({ok:true});f.settled.resolve({status:'completed',executionStarted:true,delivered:true});await new Promise(r=>setImmediate(r));
  assert.equal(f.broker.status('one').batches[0].status,'delivered');
});
