import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('sandbox bridge sends selection metadata only to the trusted host origin', () => {
  const sent = [];
  const win = { parent: { postMessage: (...args) => sent.push(args) }, scrollX: 0, scrollY: 20, innerWidth: 1200, innerHeight: 800, addEventListener() {} };
  const document = { currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener() {} };
  vm.runInNewContext(readFileSync(new URL('../web/bridge.js', import.meta.url), 'utf8'), { window: win, document, URL, setTimeout, clearTimeout, requestAnimationFrame() {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], 'https://review.example.com');
  assert.equal(sent[0][0].type, 'clawtifact:viewport');
  assert.ok(!JSON.stringify(sent).includes('csrf'));
});

test('classic bundled bridge coexists with authored lexical globals and keeps its own bindings private', () => {
  const sent = [], listeners = new Map();
  const parent = { postMessage: (...args) => sent.push(args) };
  const win = { parent, scrollX: 0, scrollY: 20, innerWidth: 1200, innerHeight: 800,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); } };
  const document = { currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener() {} };
  const context = vm.createContext({ window: win, document, URL, setTimeout, clearTimeout, requestAnimationFrame() {} });
  // Earline declares const $ in an inline script before the deferred bridge runs.
  vm.runInContext('const $ = id => id; const card = "authored";', context);
  const globals = Object.keys(context).sort();
  const bundle = readFileSync(new URL('../dist/bridge.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => vm.runInContext(bundle, context), 'classic bridge must not redeclare authored lexical names');
  assert.deepEqual(Object.keys(context).sort(), globals, 'bundle implementation must not leak global bindings');
  assert.equal(vm.runInContext('$(card)', context), 'authored');
  assert.equal(sent[0][0].type, 'clawtifact:viewport');
  assert.equal(listeners.get('message').length, 2, 'viewport/selection and snapshot responders both initialize');
  for (const receive of listeners.get('message')) receive({ source: parent, origin: 'https://review.example.com', data: { type: 'clawtifact:request-viewport' } });
  assert.equal(sent.length, 2);
  // The opposite ordering must also leave names available to authored scripts.
  assert.doesNotThrow(() => vm.runInContext('const E = "later authored script";', context));
});

test('element hit testing requires the actual parent origin and a matching current viewport', () => {
  const sent=[], listeners=new Map(),parent={postMessage:(data,origin)=>sent.push({data,origin})};
  const node={tagName:'BUTTON',closest(selector){return selector==='[data-clawtifact-marker]'?null:this;},getBoundingClientRect(){return {left:100,top:50,width:200,height:80,right:300,bottom:130};}};
  const win={parent,scrollX:0,scrollY:20,innerWidth:1200,innerHeight:800,addEventListener:(type,fn)=>listeners.set(type,fn)};
  const document={currentScript:{src:'https://review.example.com/artifacts/assets/bridge.js'},addEventListener(){},elementFromPoint:()=>node};
  vm.runInNewContext(readFileSync(new URL('../web/bridge.js',import.meta.url),'utf8'),{window:win,document,URL,setTimeout,clearTimeout,requestAnimationFrame(){}});
  const request={type:'clawtifact:hit-test',requestId:'12345678-1234-4234-8234-123456789012',x:150,y:90,viewport:{scrollX:0,scrollY:20,viewportWidth:1200,viewportHeight:800}};
  const receive=listeners.get('message');
  receive({source:{},origin:'https://review.example.com',data:request});
  receive({source:parent,origin:'https://wrong.example',data:request});
  receive({source:parent,origin:'https://review.example.com',data:{...request,viewport:{...request.viewport,scrollY:21}}});
  assert.equal(sent.length,1);
  receive({source:parent,origin:'https://review.example.com',data:request});
  assert.equal(sent.length,2);assert.equal(sent[1].data.type,'clawtifact:hit-result');assert.equal(sent[1].data.requestId,request.requestId);assert.equal(sent[1].origin,'https://review.example.com');
  assert.equal(sent[1].data.anchor.width,200/1200);assert.equal(sent[1].data.anchor.scrollKnown,true);
});
