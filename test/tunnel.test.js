import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {CloudflareSession} from '../src/tunnel.js';
function setup(lifetimeMs=3600000){
 let now=1000, callback, command, options, stopped=[];
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 const manager=new CloudflareSession({binary:'/opt/cloudflared',proxyUrl:'http://127.0.0.1:19447',lifetimeMs,now:()=>now,spawn:(bin,args)=>{command=bin;options=args;return child},stopUnit:async unit=>{stopped.push(unit)},setTimer:fn=>{callback=fn;return {unref(){}}},clearTimer(){}});
 return {manager,child,setNow:x=>now=x,fire:()=>callback(),stopped,args:()=>options,command:()=>command};
}
test('on-demand concurrent creates share a hard deadline and independent systemd watchdog',async()=>{
 const f=setup();assert.equal(f.manager.current(),null);
 const a=f.manager.ensure(),b=f.manager.ensure();
 f.child.stderr.write('Tunnel created https://quiet-paper-reader.trycloudflare.com\nRegistered tunnel connection\n');
 const [one,two]=await Promise.all([a,b]);assert.deepEqual(one,two);
 assert.equal(one.origin,'https://quiet-paper-reader.trycloudflare.com');assert.equal(one.expiresAt,3601000);
 assert.equal(f.command(),'systemd-run');assert.ok(f.args().includes('--property=RuntimeMaxSec=3600s'));
 assert.ok(f.args().includes('--property=Restart=no'));assert.ok(f.args().includes('/dev/null'));
 f.setNow(2000);assert.equal((await f.manager.ensure()).expiresAt,one.expiresAt);
 f.setNow(one.expiresAt);assert.equal(f.manager.current(),null);
 await f.manager.close();assert.ok(f.stopped.length>=1);
});
test('process exit closes admission and startup failure is recoverable',async()=>{
 const f=setup();const pending=f.manager.ensure();f.child.emit('exit',1);
 await assert.rejects(pending,/tunnel/i);assert.equal(f.manager.current(),null);
 const retry=f.manager.ensure();f.child.stderr.write('https://fresh-session-here.trycloudflare.com\nRegistered tunnel connection\n');
 assert.ok((await retry).origin.includes('fresh-session'));await f.manager.close();
});
test('timer closes the managed service and rejects unsafe configuration',async()=>{
 const f=setup();const pending=f.manager.ensure();f.child.stdout.write('https://safe-test-session.trycloudflare.com\nRegistered tunnel connection\n');await pending;
 await f.fire();assert.equal(f.manager.current(),null);assert.equal(f.stopped.length,1);
 for(const options of [{binary:'relative',proxyUrl:'http://127.0.0.1:1'},{binary:'/opt/cf',proxyUrl:'http://example.com'},{binary:'/opt/cf',proxyUrl:'http://127.0.0.1:1',lifetimeMs:3600001}])assert.throws(()=>new CloudflareSession(options));
});

test('a printed URL is not ready until Cloudflare registers its connection',async()=>{
 const f=setup();let settled=false;const pending=f.manager.ensure().then(s=>{settled=true;return s});
 f.child.stderr.write('https://waiting-for-connection.trycloudflare.com\n');
 await new Promise(setImmediate);assert.equal(settled,false);
 f.child.stderr.write('Registered tunnel connection connIndex=0\n');
 await pending;await f.manager.close();
});
