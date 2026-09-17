// A bounded viewport render. Coordinates are PDF viewport points, not raw PDF axes.
export function detailRect({width,height,panX,panY,zoom,viewWidth,viewHeight,baseScale,dpr=1,maxPixels=2097152,maxScale=8}) {
  if(!(zoom>0))return null;
  const x=Math.max(0,-Math.round(panX)/zoom), y=Math.max(0,-Math.round(panY)/zoom);
  const right=Math.min(width,(viewWidth-Math.round(panX))/zoom);
  const bottom=Math.min(height,(viewHeight-Math.round(panY))/zoom);
  const w=right-x,h=bottom-y;
  if(w<=0 || h<=0)return null;
  const scale=Math.min(zoom*dpr,maxScale,Math.sqrt(maxPixels/(w*h)));
  if(scale<=baseScale*1.15)return null;
  return {x,y,w,h,scale,pixelWidth:Math.max(1,Math.floor(w*scale)),pixelHeight:Math.max(1,Math.floor(h*scale))};
}
export class DetailView {
  constructor({canvas,getRequest,render,delay=300,maxCacheBytes=0}) {
    Object.assign(this,{canvas,getRequest,render,delay,maxCacheBytes});this.cache=new Map();this.cacheBytes=0;this.version=0;this.timer=null;this.task=null;
  }
  cancel() {
    this.version++;clearTimeout(this.timer);this.timer=null;
    this.task?.cancel();this.task=null;
    if(this.result && !this.cached)this.result.dispose?.();this.result=null;this.cached=false;this.key=null;
    this.canvas.style.display='none';
    this.canvas.width=this.canvas.height=0;
  }
  clear() {
    this.cancel();
    for(const entry of this.cache.values())this.release(entry.result);
    this.cache.clear();this.cacheBytes=0;
  }
  release(result){if(result.dispose)result.dispose();else result.width=result.height=0;}
  show(result,request,cached=false){
    this.canvas.width=result.width;this.canvas.height=result.height;
    this.result=result;this.cached=cached;
    if(result.paint)this.repaint();else this.canvas.getContext('2d').drawImage(result,0,0);
    Object.assign(this.canvas.style,{display:'block',left:`${request.left}px`,top:`${request.top}px`,width:`${request.cssWidth}px`,height:`${request.cssHeight}px`});
  }
  remember(key,result){
    const bytes=result.bytes ?? result.width*result.height*4;
    if(!key || bytes>this.maxCacheBytes)return false;
    const previous=this.cache.get(key);
    if(previous){this.cache.delete(key);this.cacheBytes-=previous.bytes;this.release(previous.result);}
    while(this.cache.size && (this.cacheBytes+bytes>this.maxCacheBytes || this.cache.size>=6)){
      const k=this.cache.keys().next().value,e=this.cache.get(k);this.cache.delete(k);this.cacheBytes-=e.bytes;this.release(e.result);
    }
    this.cache.set(key,{result,bytes});this.cacheBytes+=bytes;return true;
  }
  repaint() {
    if(this.result?.paint)this.result.paint(this.canvas.getContext('2d'));
  }
  schedule() {
    const candidate=this.getRequest();
    if(candidate?.key && candidate.key===this.key){this.repaint();return;}
    this.cancel();
    if(!candidate)return;
    this.key=candidate?.key;const version=this.version;
    const hit=this.cache.get(candidate.key);
    if(hit){this.cache.delete(candidate.key);this.cache.set(candidate.key,hit);this.show(hit.result,candidate,true);return;}
    this.timer=setTimeout(async()=>{
      this.timer=null;
      await this.pending?.catch(()=>{});
      if(version!==this.version)return;
      const request=this.getRequest();if(!request)return;
      this.key=request.key;
      try {
        const task=this.render(request);this.task=task;this.pending=task.promise;
        const result=await task.promise;
        if(version!==this.version){if(result.dispose)result.dispose();else result.width=result.height=0;return;}
        const cached=this.remember(request.key,result);
        this.show(result,request,cached);
        if(!cached && !result.paint){this.release(result);this.result=null;}
      } catch { /* base page remains usable */ }
      finally {if(version===this.version)this.task=null;}
    },this.delay);
  }
}
