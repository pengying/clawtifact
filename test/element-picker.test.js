import test from 'node:test';
import assert from 'node:assert/strict';
const picker = await import('../web/element-picker.js').catch(() => ({}));
const viewport = { scrollX: 0, scrollY: 100, viewportWidth: 800, viewportHeight: 600 };
const region = { type: 'region', x: .1, y: .1, width: .2, height: .2, ...viewport, scrollKnown: true };
function setup(timeoutMs = 100) {
  const listeners = new Map(), sent = [], child = { postMessage: message => sent.push(message) };
  const host = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const frame = { contentWindow: child, addEventListener: (type, fn) => listeners.set('frame:'+type, fn), removeEventListener: type => listeners.delete('frame:'+type) };
  let n = 0;
  assert.equal(typeof picker.createElementPicker, 'function');
  const control = picker.createElementPicker(frame, { window: host, timeoutMs, randomUUID: () => '12345678-1234-4234-8234-'+String(++n).padStart(12,'0') });
  const respond = (overrides = {}, source = child) => listeners.get('message')?.({ source, data: { type:'clawtifact:hit-result',requestId:sent.at(-1)?.requestId,anchor:region,...overrides } });
  return { control, sent, respond, listeners, child };
}
test('hit-test admits only the exact child/request/viewport and a region containing the queried point', async () => {
  const h=setup(), result=h.control.request({x:120,y:90},viewport); let settled=false;result.then(()=>settled=true);
  h.respond({},{});h.respond({requestId:'unrelated'});h.respond({anchor:{...region,scrollY:101}});h.respond({anchor:{...region,x:.7}});
  await Promise.resolve();assert.equal(settled,false);h.respond();assert.deepEqual(await result,region);h.control.dispose();
});
test('supersession, load and disposal resolve missing hints without accepting stale results', async () => {
  const h=setup();const first=h.control.request({x:120,y:90},viewport), oldId=h.sent.at(-1).requestId;
  const second=h.control.request({x:120,y:90},viewport);assert.equal(await first,null);
  h.respond({requestId:oldId});h.listeners.get('frame:load')();assert.equal(await second,null);
  h.control.dispose();assert.equal(await h.control.request({x:120,y:90},viewport),null);assert.equal(h.listeners.size,0);
});
test('invalid geometry never leaves host and missing bridge has a bounded fallback', async () => {
  const h=setup(5);assert.equal(await h.control.request({x:NaN,y:2},viewport),null);assert.equal(await h.control.request({x:801,y:2},viewport),null);assert.equal(h.sent.length,0);
  assert.equal(await h.control.request({x:120,y:90},viewport),null);h.control.dispose();
});
