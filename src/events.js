import { randomBytes } from 'node:crypto';

// Full snapshots make reconnect independent of an in-memory replay window.
// This cursor orders discussion/receipt changes as well as content revisions.
export class ArtifactEvents {
  constructor({intervalMs=1000,maxConnections=128,maxPerDocument=2}={}) {
    this.epoch=randomBytes(12).toString('hex');this.sequence=0;
    this.clients=new Set();this.intervalMs=intervalMs;
    this.maxConnections=maxConnections;this.maxPerDocument=maxPerDocument;
  }
  get size(){return this.clients.size;}
  snapshot(value){return {...value,epoch:this.epoch,snapshotSequence:++this.sequence};}
  open({req,res,key,snapshot}) {
    if(this.size>=this.maxConnections||[...this.clients].filter(c=>c.key===key).length>=this.maxPerDocument){res.writeHead(429);res.end();return false;}
    res.setHeader('Content-Type','text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Accel-Buffering','no');
    res.writeHead(200);res.flushHeaders?.();
    const client={key,req,res,snapshot,prior:null,lastWrite:0};
    const close=()=>{this.clients.delete(client);try{if(!res.writableEnded&&!res.ended)res.end();}catch{}if(!this.size){clearInterval(this.timer);this.timer=null;}};
    client.close=close;req.once('close',close);res.once('close',close);res.once('error',close);
    this.clients.add(client);
    this.refresh(client);
    if(this.size&&!this.timer){this.timer=setInterval(()=>this.refresh(),this.intervalMs);this.timer.unref?.();}
    return true;
  }
  refresh(only) {
    for(const c of only?[only]:[...this.clients]) {
      if(!this.clients.has(c))continue;
      try{
        const value=c.snapshot();
        if(!value){c.res.write('event: expired\ndata: {}\n\n');c.close();continue;}
        const raw=JSON.stringify(value);
        if(raw.length>262144){c.close();continue;}
        if(raw!==c.prior){
          const snapshot=this.snapshot(value);
          if(!c.res.write(`id: ${this.epoch}:${snapshot.snapshotSequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)){c.close();continue;}
          c.prior=raw;c.lastWrite=Date.now();
        }else if(Date.now()-c.lastWrite>=15000){if(!c.res.write(': keepalive\n\n'))c.close();c.lastWrite=Date.now();}
      }catch{c.close();}
    }
  }
  revoke(key){for(const c of [...this.clients])if(c.key===key){try{c.res.write('event: expired\ndata: {}\n\n');}catch{}finally{c.close();}}}
  close(){for(const c of [...this.clients])c.close();}
}
