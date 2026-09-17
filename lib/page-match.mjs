// Compact local features; similarity only proposes correspondence, never equality.
export function pageFeature(text, rgba, ratio) {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '').slice(0, 20000);
  const grams = new Set();
  for (let i = 0; i + 1 < normalized.length; i++) grams.add(normalized.slice(i, i + 2));
  const ink = new Float32Array(rgba.length / 4);
  let norm = 0;
  for (let i = 0; i < ink.length; i++) {
    ink[i] = 1 - (rgba[i*4]*0.299 + rgba[i*4+1]*0.587 + rgba[i*4+2]*0.114)/255;
    norm += ink[i]*ink[i];
  }
  return { grams, ink, norm: Math.sqrt(norm), ratio };
}
export function pageSimilarity(a, b) {
  if (!a || !b || Math.abs(Math.log(a.ratio/b.ratio)) > 0.15) return 0;
  let dot = 0;
  for (let i = 0; i < a.ink.length; i++) dot += a.ink[i]*b.ink[i];
  const visual = a.norm > 0.1 && b.norm > 0.1 ? dot/(a.norm*b.norm) : 0;
  if (a.grams.size < 8 || b.grams.size < 8) return visual;
  let common = 0;
  for (const gram of a.grams) if (b.grams.has(gram)) common++;
  return 0.8 * (2*common/(a.grams.size+b.grams.size)) + 0.2*visual;
}
export async function suggestPageMap(a, b, checkpoint = async () => {}) {
  const topA = [], topB = b.map(() => ({score:0, second:0, index:-1}));
  function add(top, score, index) {
    if (score > top.score) { top.second=top.score; top.score=score; top.index=index; }
    else top.second=Math.max(top.second,score);
  }
  for (let i=0; i<a.length; i++) {
    await checkpoint(i);
    const top={score:0,second:0,index:-1};
    for (let j=0; j<b.length; j++) {
      if(j && j%64===0) await checkpoint(i);
      const score=pageSimilarity(a[i],b[j]);
      add(top,score,j); add(topB[j],score,i);
    }
    topA.push(top);
  }
  // Mutual, distinct best matches avoid duplicate assignments and arbitrary blank matches.
  return topA.map((top,i) => {
    const reverse=topB[top.index];
    const certain=top.score>=0.78 && top.score-top.second>=0.06 &&
      reverse?.index===i && reverse.score-reverse.second>=0.06;
    return {page:certain?top.index:null, review:!certain};
  });
}
