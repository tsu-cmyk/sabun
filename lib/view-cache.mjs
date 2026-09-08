// Bounded LRU for completed comparisons. Keys include document identity and all comparison inputs.
export class ViewCache {
  constructor(maxBytes, maxEntries = 6) { this.maxBytes=maxBytes; this.maxEntries=maxEntries; this.bytes=0; this.entries=new Map(); }
  get(key) { const entry=this.entries.get(key); if(!entry)return null; this.entries.delete(key);this.entries.set(key,entry);return entry.value; }
  set(key,value) {
    const bytes=value.img.data.byteLength;
    const previous=this.entries.get(key);if(previous){this.bytes-=previous.bytes;this.entries.delete(key);}
    if(bytes>this.maxBytes)return;
    this.entries.set(key,{value,bytes});this.bytes+=bytes;
    while(this.bytes>this.maxBytes||this.entries.size>this.maxEntries){const oldest=this.entries.keys().next().value;this.bytes-=this.entries.get(oldest).bytes;this.entries.delete(oldest);}
  }
  clear(){this.entries.clear();this.bytes=0;}
}
