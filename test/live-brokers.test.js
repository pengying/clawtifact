import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackBroker } from '../src/feedback.js';
import { ArtifactDiscussion } from '../src/discussion.js';
const id='12345678-1234-4234-8234-123456789abc',rev='a'.repeat(32),next='b'.repeat(32);
const ctx={agentId:'main',sessionKey:'source',sessionId:'one',deliveryContext:{channel:'telegram',to:'owner',threadId:'topic'},assertInvocationCurrent(){}};
async function fixture(mode='discuss'){
 const events=[];const feedback=new FeedbackBroker({system:{captureSessionEventTarget:async()=>({}),enqueueSessionEvent(text){events.push(text);return{accepted:Promise.resolve({ok:true}),settled:new Promise(()=>{})};}}});
 feedback.bind('doc',await feedback.capture(ctx),Date.now()+60000,{feedbackMode:mode});
 const requests=[];const discussion=new ArtifactDiscussion({feedback,complete:async input=>{requests.push(input);return{text:'Reply',execution:{mode:'direct-provider'}};},authorize:async()=>true});
 return{events,feedback,discussion,requests};
}
test('feedback binds dedup and read acknowledgement to exact reviewed revision; owner opt-in narrows revision workflow',async()=>{
 const f=await fixture('revise'),body={id,revisionId:rev,comments:[{text:'Simplify',anchor:{type:'general'}}]};
 assert.equal(f.feedback.submit('doc',body,{title:'Plan',revisionId:rev}).revisionId,rev);
 assert.match(f.events[0],/artifact_update/);assert.match(f.events[0],/only this document/i);
 assert.throws(()=>f.feedback.submit('doc',{...body,revisionId:next},{title:'Plan',revisionId:next}),/different|revision/i);
 const read=f.feedback.readBatch(ctx,'doc',id);assert.equal(JSON.parse(read.content[0].text).revisionId,rev);
 const g=await fixture();g.feedback.submit('doc',body,{title:'Plan',revisionId:rev});assert.match(g.events[0],/Do not revise/);
});
test('Chat pins source per message and exposes canonical idempotent owner messages without mirror send',async()=>{
 const f=await fixture('revise');
 const first={title:'One',format:'markdown',markdown:'Version one',revisionId:rev};
 f.discussion.submit('doc',{id,text:'Explain',revisionId:rev},first);
 assert.match(f.events[0],/artifact_update/);
 await f.discussion.respond(ctx,'doc',id);
 const nextId='22345678-1234-4234-8234-123456789abc';
 f.discussion.now=()=>Date.now()+6000;
 f.discussion.submit('doc',{id:nextId,text:'Now?',revisionId:next},{...first,title:'Two',markdown:'Version two',revisionId:next});
 await f.discussion.respond(ctx,'doc',nextId);
 assert.match(JSON.stringify(f.requests[1]),/Version two/);assert.doesNotMatch(JSON.stringify(f.requests[1]),/Version one/);
 assert.throws(()=>f.discussion.submit('doc',{id,text:'Explain',revisionId:next},{...first,revisionId:next}),/different|revision/i);
 assert.equal(typeof f.discussion.push,'function');
 const noteId='32345678-1234-4234-8234-123456789abc';
 const note={messageId:noteId,text:'Updated the heading',revisionId:next};
 const pushed=f.discussion.push(ctx,'doc',note);assert.equal(pushed.role,'agent');
 f.discussion.push(ctx,'doc',note);assert.equal(f.discussion.status('doc').messages.filter(m=>m.id===noteId).length,1);
 assert.throws(()=>f.discussion.push({...ctx,sessionId:'retired'},'doc',note));
 assert.throws(()=>f.discussion.push(ctx,'doc',{...note,text:'Changed'}),/different/i);
});
