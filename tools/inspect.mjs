import fs from 'fs';
function parse(p){
  const b = fs.readFileSync(p);
  const len = b.readUInt32LE(8);
  let off = 12, json=null;
  while(off < len){
    const cl = b.readUInt32LE(off), ct = b.readUInt32LE(off+4);
    if(ct === 0x4E4F534A) json = JSON.parse(b.slice(off+8, off+8+cl).toString('utf8'));
    off += 8 + cl;
  }
  return json;
}
for (const f of process.argv.slice(2)) {
  const j = parse(f);
  console.log('=========', f);
  console.log('animations:', (j.animations||[]).map(a=>`${a.name}(${a.channels.length}ch)`).join(', '));
  console.log('meshes:', (j.meshes||[]).map(m=>m.name+':'+m.primitives.length).join(', '));
  console.log('materials:', (j.materials||[]).map(m=>m.name).join(', '));
  console.log('skins:', (j.skins||[]).map(s=>`joints=${s.joints.length}`).join(', '));
  const nodes = j.nodes||[];
  if (j.skins && j.skins[0]) {
    console.log('JOINTS:', j.skins[0].joints.map(i=>nodes[i].name).join(' | '));
  }
  console.log('images:', (j.images||[]).map(i=>i.name+' '+(i.mimeType||'')).join(', '));
  console.log('rootNodes:', (j.scenes?.[0]?.nodes||[]).map(i=>nodes[i].name).join(', '));
}
