import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ArtifactStore} from '../src/store.js';
import {FeedbackBroker} from '../src/feedback.js';
import {createHandler} from '../src/http.js';
import {ArtifactEvents} from '../src/events.js';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'artifact-live-http-'));let now=1000;
 const store=new ArtifactStore({file:join(dir,'db'),now:()=>now});
 const feedback=new FeedbackBroker({now:()=>now,system:{captureSessionEventTarget:async()=>({}),enqueueSessionEvent(){return{accepted:Promise.resolve({ok:true}),settled:new Promise(()=>{})};}}});
 const item=store.create({owner:'source',title:'v1',markdown:'# Old heading',expiresAt:2000});
 feedback.bind(item.id,await feedback.capture({agentId:'main',sessionKey:'source'}),2000);
 const events=new ArtifactEvents({intervalMs:10});let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 handler=createHandler({store,origin,secure:false,feedback,events});
 t.after(async()=>{events.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true});});
 const session=store.claim(item.token),path='/artifacts/'+item.token,cookie='oc_art_session='+session;
 const request=(suffix='',options={})=>fetch(origin+path+suffix,{...options,headers:{cookie,...options.headers}});
 const host=await request();const html=await host.text(),csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)[1];
 const post=(action,body)=>request('/'+action,{method:'POST',headers:{origin,cookie:cookie+'; oc_art_feedback='+csrf,'content-type':'application/json'},body:JSON.stringify({csrf,...body})});
 return{store,feedback,events,item,request,post,html,expire(){now=2000;},publish(){return store.publish({id:item.id,owner:'source',expectedRevision:item.revisionId,requestId:'12345678-1234-4234-8234-123456789abc',title:'v2',markdown:'# New heading'});}};
}
test('claimed live viewer gets exact immutable content, head status and guarded applied acknowledgement',async t=>{
 const f=await fixture(t);assert.match(f.html,new RegExp('data-revision-id="'+f.item.revisionId+'"'));
 assert.equal((await f.request('/status',{headers:{cookie:''}})).status,404);
 const published=f.publish();const status=await(await f.request('/status')).json();assert.equal(status.head.revisionId,published.revisionId);
 assert.equal(typeof status.epoch,'string');assert.ok(status.snapshotSequence>0);
 const old=await(await f.request('/content?revision='+f.item.revisionId)).text();assert.match(old,/Old heading/);assert.doesNotMatch(old,/New heading/);
 assert.equal((await f.request('/content?revision='+'f'.repeat(32))).status,404);
 assert.equal((await f.post('applied',{revisionId:published.revisionId})).status,202);
 assert.equal(f.store.inspect(f.item.id,'source').appliedRevision,published.revisionId);
 const input={id:'22345678-1234-4234-8234-123456789abc',revisionId:f.item.revisionId,comments:[{text:'Old feedback',anchor:{type:'general'}}]};
 assert.equal((await f.post('feedback',input)).status,202);
 assert.equal(f.feedback.status(f.item.id).batches[0].revisionId,f.item.revisionId);
 assert.equal((await f.post('feedback',{...input,revisionId:published.revisionId})).status,409);
 const {revisionId,...missing}=input;assert.equal((await f.post('feedback',missing)).status,400);
});
test('real SSE gives initial and changed snapshots, requires claim and closes on expiry',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/events',{headers:{cookie:''}})).status,404);
 const stream=await f.request('/events');assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
 const reader=stream.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/event: snapshot/);assert.match(first,new RegExp(f.item.revisionId));
 const published=f.publish();f.events.refresh();const second=new TextDecoder().decode((await reader.read()).value);assert.match(second,new RegExp(published.revisionId));
 f.expire();f.events.refresh();const terminal=new TextDecoder().decode((await reader.read()).value);assert.match(terminal,/event: expired/);await reader.cancel();
});
