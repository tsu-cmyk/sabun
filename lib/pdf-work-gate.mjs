// Cleanup is exclusive: no new PDF work enters until maintenance has finished.
export class PdfWorkGate {
  constructor(){this.active=0;this.barrier=Promise.resolve();this.drained=[];}
  async run(work){
    const ticket=this.barrier;await ticket;
    if(ticket!==this.barrier)return this.run(work);
    this.active++;
    try{return await work();}finally{if(--this.active===0){for(const done of this.drained.splice(0))done();}}
  }
  maintain(work){
    const job=this.barrier.then(async()=>{if(this.active)await new Promise(resolve=>this.drained.push(resolve));return work();});
    this.barrier=job.catch(()=>{});return job;
  }
}
