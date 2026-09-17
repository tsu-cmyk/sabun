// Refine appearance only inside the authoritative base comparison's support.
// Yield between strips so tab changes can cancel composition before it finishes.
export async function refineComparison(r,a,b,cancelled=()=>false){
 const {pixelWidth:w,pixelHeight:h,reference:ref}=r,out=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++){
  if(y%32===0){await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())throw Error('cancelled');}
  const by=Math.min(ref.height-1,Math.max(0,Math.floor((r.y+y/r.scale)*r.baseScale)));
  for(let x=0;x<w;x++){
   const p=(y*w+x)*4,bx=Math.min(ref.width-1,Math.max(0,Math.floor((r.x+x/r.scale)*r.baseScale))),q=(by*ref.width+bx)*4,d=ref.data;
   if(r.mode==='highlight'){
    const marked=(d[q]===255&&d[q+1]===75&&d[q+2]===0)||(d[q]===0&&d[q+1]===196&&d[q+2]===255);
    for(let c=0;c<3;c++)out[p+c]=marked?d[q+c]:Math.floor(a[p+c]*.3);
   }else{
    // Show the high-resolution luminance difference only inside base support.
    const v=d[q]===0?0:Math.abs((a[p]-b[p])*.299+(a[p+1]-b[p+1])*.587+(a[p+2]-b[p+2])*.114);
    out[p]=out[p+1]=out[p+2]=v;
   }
   out[p+3]=255;
  }
 }
 return out;
}
