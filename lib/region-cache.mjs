// Cache geometry only, never PDF pixels. Deduplicate concurrent consumers.
export class RegionCache {
  constructor(maxEntries = 32, maxRegions = 20000) {
    this.maxEntries=maxEntries;this.maxRegions=maxRegions;
    this.entries=new Map();this.pending=new Map();this.size=0;this.generation=0;
  }
  get(key) {
    const value=this.entries.get(key);if(!value)return null;
    this.entries.delete(key);this.entries.set(key,value);return value;
  }
  set(key,value) {
    const old=this.entries.get(key);if(old){this.size-=old.regions.length;this.entries.delete(key);}
    if(value.regions.length>this.maxRegions)return;
    this.entries.set(key,value);this.size+=value.regions.length;
    while(this.entries.size>this.maxEntries || this.size>this.maxRegions) {
      const first=this.entries.keys().next().value;
      this.size-=this.entries.get(first).regions.length;this.entries.delete(first);
    }
  }
  async obtain(key,compute) {
    const hit=this.get(key);if(hit)return hit;
    if(this.pending.has(key))return this.pending.get(key);
    const generation=this.generation;
    const job=Promise.resolve().then(compute).then(value=>{if(generation===this.generation)this.set(key,value);return value;});
    this.pending.set(key,job);
    try{return await job;}finally{if(this.pending.get(key)===job)this.pending.delete(key);}
  }
  clear(){this.generation++;this.entries.clear();this.pending.clear();this.size=0;}
}
