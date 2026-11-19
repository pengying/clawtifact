import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackBroker } from '../src/feedback.js';
const mod = await import('../src/discussion.js').catch(() => ({}));
const messageId = '12345678-1234-4234-8234-123456789abc';

test('completion failures report only allowlisted codes and stage, never provider errors or artifact content', async () => {
  for (const code of ['LLM_COMPLETION_NOT_AUTHORIZED', 'secret-provider-token']) {
    const f = fixture(), diagnostics = [];
    f.discussion.onError = diagnostic => diagnostics.push(diagnostic);
    f.discussion.complete = async () => { throw Object.assign(new Error('PRIVATE PROVIDER DETAIL'), { code }); };
    f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
    f.discussion.submit('one', { id: messageId, text: 'PRIVATE REVIEWER TEXT' }, { title: 'PRIVATE TITLE', markdown: 'PRIVATE DOCUMENT' });
    const result = await f.discussion.respond(f.ctx, 'one', messageId);
    assert.equal(result.status, 'failed');
    assert.deepEqual(diagnostics, [{ stage: 'inference', code: code === 'LLM_COMPLETION_NOT_AUTHORIZED' ? code : 'UNKNOWN' }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|secret-provider/);
    assert.equal(f.deliveries.length, 0);
    await f.discussion.respond(f.ctx, 'one', messageId);
    assert.equal(diagnostics.length, 1, 'failed inference is never automatically repeated');
  }
});

test('provider error or aborted results never publish partial text or mirror an exchange', async () => {
  for (const stopReason of ['error', 'aborted']) {
    const f = fixture(); let attempts = 0;
    f.discussion.complete = async () => {
      attempts++;
      return { text: 'Partial provider output', stopReason, execution: { mode: 'direct-provider' } };
    };
    f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
    f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'QA', markdown: 'QA' });
    const result = await f.discussion.respond(f.ctx, 'one', messageId);
    assert.equal(result.status, 'failed');
    assert.equal(result.reply, undefined);
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.events.length, 1, 'only the initial request is queued, never a mirror');
    await f.discussion.respond(f.ctx, 'one', messageId);
    assert.equal(attempts, 1, 'terminal provider failure cannot repeat inference');
  }
});

test('diagnostic logging failure cannot change the failed reply or cause another send', async () => {
  const f = fixture(); let attempts = 0;
  f.discussion.onError = () => { attempts++; throw new Error('logger unavailable'); };
  f.discussion.complete = async () => { throw new Error('provider unavailable'); };
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'QA', markdown: 'QA' });
  assert.equal((await f.discussion.respond(f.ctx, 'one', messageId)).status, 'failed');
  assert.equal(f.discussion.inFlight, 0);
  assert.equal(f.deliveries.length, 0);
  assert.equal(attempts, 1);
});
function fixture() {
  assert.equal(typeof mod.ArtifactDiscussion, 'function');
  let now = 1000; const events = [], requests = [], deliveries = [];
  const feedback = new FeedbackBroker({ now: () => now, system: { captureSessionEventTarget: async () => ({}), enqueueSessionEvent(text, options) { events.push({ text, options }); return { accepted: Promise.resolve({ ok: true }), settled: new Promise(() => {}) }; } } });
  const ctx = { agentId: 'main', sessionKey: 'original', sessionId: 'incarnation-a', deliveryContext: { channel: 'telegram', to: 'original', accountId: 'default', threadId: 'one' }, privateHistory: 'OWNER SECRET', assertInvocationCurrent() {}, delivery: { send: async payload => { deliveries.push(payload); } } };
  const discussion = new mod.ArtifactDiscussion({ feedback, authorize: async ctx => ctx.qaDeny !== true, now: () => now, complete: async params => { requests.push(params); return { text: 'Use a simpler second step.', execution: { mode: 'direct-provider' } }; } });
  return { feedback, ctx, discussion, events, requests, deliveries, advance: () => { now += 6000; } };
}

test('chat queues once, completes only in original incarnation with artifact-only context, and mirrors one canonical exchange', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  const document = { title: 'Plan', markdown: '# Public plan', privateField: 'DO NOT INCLUDE' };
  f.discussion.submit('one', { id: messageId, text: 'Can we simplify this?' }, document);
  f.discussion.submit('one', { id: messageId, text: 'Can we simplify this?' }, document);
  assert.equal(f.events.length, 1); assert.equal(f.requests.length, 0, 'anonymous HTTP must not dispatch the model');
  assert.match(f.events[0].text, /artifact_chat_respond/);
  await assert.rejects(f.discussion.respond({ ...f.ctx, sessionId: 'reset' }, 'one', messageId));
  await assert.rejects(f.discussion.respond({ ...f.ctx, deliveryContext: { ...f.ctx.deliveryContext, threadId: 'another-thread' } }, 'one', messageId));
  assert.equal(f.requests.length, 0);
  const result = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(result.reply, 'Use a simpler second step.');
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 1);
  const requestText = JSON.stringify(f.requests[0]);
  assert.match(requestText, /Public plan/); assert.match(requestText, /Can we simplify/);
  assert.doesNotMatch(requestText, /OWNER SECRET|DO NOT INCLUDE/);
  assert.match(f.deliveries[0].text, /Can we simplify/); assert.match(f.deliveries[0].text, /simpler second step/);
  await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 1);
  assert.equal(f.discussion.status('one').messages[0].status, 'replied');
});

test('chat rejects retargeting, duplicate mutations, concurrent turns and denied live reply permission', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  assert.throws(() => f.discussion.submit('one', { id: messageId, text: 'Hi', model: 'evil/model' }, { title: 'Plan', html: '<p>Public</p>' }));
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan', html: '<p>Public</p>' });
  assert.throws(() => f.discussion.submit('one', { id: messageId, text: 'Changed' }, { title: 'Plan' }), /different/i);
  assert.throws(() => f.discussion.submit('one', { id: '22345678-1234-4234-8234-123456789abc', text: 'More' }, { title: 'Plan' }), /pending/i);
  assert.equal((await f.discussion.respond({ ...f.ctx, qaDeny: true }, 'one', messageId)).status, 'blocked');
  assert.equal(f.requests.length, 0);
});

test('ambiguous channel delivery never triggers a duplicate model call or duplicate mirror', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.ctx.delivery.send = async () => { throw new Error('uncertain network'); };
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan', markdown: 'Plan' });
  const first = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(first.mirrorStatus, 'uncertain');
  await f.discussion.respond(f.ctx, 'one', messageId); assert.equal(f.requests.length, 1);
  f.feedback.clear(); assert.equal(f.discussion.status('one').enabled, false);
});

test('image descriptions are requested only in the admitted original turn and included as explicitly scoped visual context', async () => {
  const f = fixture(), imageId = 'a'.repeat(32); let descriptions = 0;
  f.feedback.images = { available: () => true, get: () => ({ id: imageId, mimeType: 'image/jpeg', bytes: Buffer.from([255,216,255,217]) }), remove() {} };
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.feedback.submit('one', { id: messageId, comments: [{ text: 'This chart', anchor: { type: 'general' }, imageId }] }, { title: 'Plan' });
  f.discussion.describeImage = async image => { descriptions++; assert.equal(image.mimeType, 'image/jpeg'); return 'A red bar is higher than a blue bar.'; };
  f.discussion.submit('one', { id: messageId, text: 'Explain the screenshot' }, { title: 'Plan', markdown: 'A chart' });
  assert.equal(descriptions, 0);
  await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(descriptions, 1);
  const prompt = JSON.parse(f.requests[0].messages[0].content);
  assert.match(JSON.stringify(prompt.imageDescriptions), /red bar/);
  assert.equal(prompt.annotations[0].commentNumber, 1);
});

test('a completed session event without the reply tool fails visibly rather than staying queued forever', async () => {
  const f = fixture();
  f.feedback.system.enqueueSessionEvent = () => ({ accepted: Promise.resolve({ ok: true }), settled: Promise.resolve({ delivered: true }) });
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.discussion.status('one').messages[0].status, 'failed');
});


test('blocked live authority is visible, retryable only before inference, and recovers with the same immutable ID', async () => {
  const f = fixture();
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000, { chatEnabled: false });
  assert.equal(f.discussion.enabled('one'), true, 'legacy creation snapshot cannot disable supported Chat');
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  const blocked = await f.discussion.respond({ ...f.ctx, qaDeny: true }, 'one', messageId);
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.error, /permission/i);
  assert.equal(f.requests.length, 0);
  f.advance();
  assert.throws(() => f.discussion.submit('one', { id: messageId, text: 'Changed', retry: true }, {}), /different/i);
  const retry = f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
  assert.equal(retry.status, 'queued'); assert.equal(f.events.length, 2);
  const reply = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(reply.status, 'replied'); assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 1);
  f.advance();
  f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
  assert.equal(f.events.length, 2, 'retry cannot duplicate an already completed reply');
});

test('current response policy is rechecked and denial never invokes a model or mirror', async () => {
  const f = fixture(); let allowed = false;
  f.discussion.authorize = async () => allowed;
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  const blocked = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.error, /permission/i);
  assert.equal(f.requests.length, 0); assert.equal(f.deliveries.length, 0);
  allowed = true;
  const reply = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(reply.status, 'replied'); assert.equal(f.requests.length, 1);
});

test('an old event settlement cannot fail a newer explicit retry', async () => {
  const f = fixture(); const settle = [];
  f.feedback.system.enqueueSessionEvent = () => ({ accepted: Promise.resolve({ ok: true }), settled: new Promise(resolve => settle.push(resolve)) });
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  await f.discussion.respond({ ...f.ctx, qaDeny: true }, 'one', messageId);
  f.advance();
  f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
  settle[0]({ delivered: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.discussion.status('one').messages[0].status, 'queued');
  await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(f.deliveries.length, 1);
});

test('concurrent response attempts cannot bypass asynchronous authorization or duplicate inference', async () => {
  const f = fixture(); let allow;
  f.discussion.authorize = () => new Promise(resolve => { allow = resolve; });
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  const first = f.discussion.respond(f.ctx, 'one', messageId);
  const duplicate = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(duplicate.status, 'responding'); assert.equal(f.requests.length, 0);
  allow(true); await first;
  assert.equal(f.requests.length, 1); assert.equal(f.deliveries.length, 1);
});

test('retry is rate limited, bounded and never repeats inference failures or ambiguous mirrors', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.discussion.respond({ ...f.ctx, qaDeny: true }, 'one', messageId);
    assert.throws(() => f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {}), /limit/i);
    f.advance();
    if (attempt < 3) f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
  }
  assert.throws(() => f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {}), /limit/i);
  assert.equal(f.events.length, 3); assert.equal(f.requests.length, 0);
  f.discussion.complete = async () => { f.requests.push({}); throw new Error('ambiguous provider result'); };
  await f.discussion.respond(f.ctx, 'one', messageId);
  f.advance();
  const failed = f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
  assert.equal(failed.status, 'failed'); assert.equal(f.events.length, 3); assert.equal(f.requests.length, 1);
});

test('revocation while checking policy cannot invoke inference and missing policy support fails closed', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
  f.discussion.authorize = undefined;
  assert.equal((await f.discussion.respond(f.ctx, 'one', messageId)).status, 'blocked');
  f.discussion.authorize = async () => { f.feedback.remove('one'); return true; };
  const result = await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(result.status, 'failed'); assert.equal(f.requests.length, 0); assert.equal(f.deliveries.length, 0);
});

test('direct blocked recovery cannot overlap a different pending turn in the same artifact', async () => {
  const f = fixture(); f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'First' }, { title: 'Plan' });
  await f.discussion.respond({ ...f.ctx, qaDeny: true }, 'one', messageId);
  f.advance();
  const secondId = '22345678-1234-4234-8234-123456789abc';
  f.discussion.submit('one', { id: secondId, text: 'Second' }, { title: 'Plan' });
  await assert.rejects(f.discussion.respond(f.ctx, 'one', messageId), /pending/i);
  assert.equal(f.discussion.status('one').messages[0].status, 'blocked');
  assert.equal(f.requests.length, 0);
  await f.discussion.respond(f.ctx, 'one', secondId);
  await f.discussion.respond(f.ctx, 'one', messageId);
  assert.equal(f.requests.length, 2);
});

test('CLI turns without direct delivery mirror through the captured original-session queue and await settlement proof', async () => {
  const f = fixture(); const settle = [];
  f.feedback.system.enqueueSessionEvent = (text, options) => {
    f.events.push({ text, options });
    return { accepted: Promise.resolve({ ok: true }), settled: new Promise(resolve => settle.push(resolve)) };
  };
  f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
  f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan', markdown: 'Public plan' });
  const ctx = { ...f.ctx, delivery: undefined };
  const reply = await f.discussion.respond(ctx, 'one', messageId);
  assert.equal(reply.status, 'replied');
  assert.equal(reply.mirrorStatus, 'queued');
  assert.equal(f.events.length, 2);
  assert.match(f.events[1].text, /Use a simpler second step/);
  assert.equal(f.events[1].options.expectedTarget, f.feedback.routes.get('one').captured.expectedTarget);
  assert.deepEqual(f.events[1].options.deliveryContext, f.ctx.deliveryContext);
  assert.doesNotMatch(f.events[1].text, /OWNER SECRET/);
  await f.discussion.respond(ctx, 'one', messageId);
  assert.equal(f.requests.length, 1); assert.equal(f.events.length, 2);
  settle[0]({ delivered: true }); // The request event is NOT the mirror receipt.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.discussion.status('one').messages[0].mirrorStatus, 'queued');
  settle[1]({ delivered: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.discussion.status('one').messages[0].mirrorStatus, 'delivered');
});

test('queued mirror rejection and ambiguous settlement stay visible without repeated inference or sends', async () => {
  for (const scenario of ['rejected', 'uncertain', 'failed']) {
    const f = fixture(); let calls = 0;
    f.feedback.system.enqueueSessionEvent = (text, options) => {
      f.events.push({ text, options }); calls++;
      return calls === 1 ? { accepted: Promise.resolve({ ok: true }), settled: new Promise(() => {}) }
        : { accepted: Promise.resolve({ ok: scenario !== 'rejected' }), settled: Promise.resolve({ delivered: false, deliveryAttempted: scenario === 'uncertain' }) };
    };
    f.feedback.bind('one', await f.feedback.capture(f.ctx), 60000);
    f.discussion.submit('one', { id: messageId, text: 'Hi' }, { title: 'Plan' });
    const ctx = { ...f.ctx, delivery: undefined };
    await f.discussion.respond(ctx, 'one', messageId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.discussion.status('one').messages[0].mirrorStatus, scenario === 'uncertain' ? 'uncertain' : 'failed');
    await f.discussion.respond(ctx, 'one', messageId);
    f.advance(); f.discussion.submit('one', { id: messageId, text: 'Hi', retry: true }, {});
    assert.equal(f.events.length, 2); assert.equal(f.requests.length, 1);
  }
});
