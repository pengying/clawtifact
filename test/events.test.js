import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const { ArtifactEvents } = await import('../src/events.js').catch(() => ({}));
function client() {
  const req=new EventEmitter(),res=new EventEmitter();
  Object.assign(res,{headers:{},chunks:[],setHeader(k,v){this.headers[k]=v;},writeHead(n){this.status=n;},write(s){this.chunks.push(s);return true;},end(){this.ended=true;this.emit('close');}});
  return{req,res};
}
test('SSE reconciles immediately, versions status-only changes and bounds connections',()=>{
  assert.equal(typeof ArtifactEvents,'function');
  const hub=new ArtifactEvents({intervalMs:10000,maxConnections:2,maxPerDocument:1});
  let value={head:{sequence:1},feedback:{batches:[]}};
  const a=client();assert.equal(hub.open({...a,key:'one',snapshot:()=>value}),true);
  assert.equal(a.res.headers['Content-Type'],'text/event-stream; charset=utf-8');
  assert.match(a.res.chunks.join(''),/event: snapshot/);assert.match(a.res.chunks.join(''),/"sequence":1/);
  const old=a.res.chunks.join('');hub.refresh();assert.equal(a.res.chunks.join(''),old);
  value={...value,feedback:{batches:[{status:'received'}]}};hub.refresh();
  assert.match(a.res.chunks.at(-1),/received/);assert.notEqual(a.res.chunks[0].match(/id: (.+)/)?.[1],a.res.chunks.at(-1).match(/id: (.+)/)?.[1]);
  const extra=client();assert.equal(hub.open({...extra,key:'one',snapshot:()=>value}),false);assert.equal(extra.res.status,429);
  a.req.emit('close');assert.equal(hub.size,0);
  const reconnected=client();assert.equal(hub.open({...reconnected,key:'one',snapshot:()=>value}),true);assert.match(reconnected.res.chunks.join(''),/received/);
  hub.close();assert.equal(reconnected.res.ended,true);
});
test('SSE closes on expiry, invalidation and backpressure rather than retaining auth or buffering',()=>{
  assert.equal(typeof ArtifactEvents,'function');
  const hub=new ArtifactEvents({intervalMs:10000});let live=true;
  const a=client();hub.open({...a,key:'one',snapshot:()=>live?{head:{sequence:1}}:null});
  live=false;hub.refresh();assert.equal(a.res.ended,true);assert.equal(hub.size,0);
  const slow=client();slow.res.write=()=>false;hub.open({...slow,key:'two',snapshot:()=>({})});
  assert.equal(slow.res.ended,true);assert.equal(hub.size,0);hub.close();
});
test('a failed subscriber cannot turn canonical revocation into an exception',()=>{
 const hub=new ArtifactEvents({intervalMs:10000});const a=client();hub.open({...a,key:'one',snapshot:()=>({})});
 a.res.write=()=>{throw new Error('socket closed');};assert.doesNotThrow(()=>hub.revoke('one'));assert.equal(hub.size,0);hub.close();
});
