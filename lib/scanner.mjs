import fs from 'node:fs/promises';
import path from 'node:path';

// Read metadata only, never load tensor weights into memory.
export async function ggufMetadata(file) {
  const h = await fs.open(file, 'r');
  let pos = 0, cachedStart = 0, cached = Buffer.alloc(0);
  const read = async n => {
    if (n > 1048576 || pos + n > 32 * 1048576) throw new Error('GGUF 元数据超过读取上限');
    if (pos < cachedStart || pos+n > cachedStart+cached.length) {
      const b = Buffer.alloc(Math.max(65536,n)); const {bytesRead} = await h.read(b,0,b.length,pos);
      cachedStart=pos;cached=b.subarray(0,bytesRead);
    }
    if(pos+n>cachedStart+cached.length)throw new Error('GGUF 文件不完整');
    const result=cached.subarray(pos-cachedStart,pos-cachedStart+n);pos+=n;return result;
  };
  const u32 = async () => (await read(4)).readUInt32LE();
  const u64 = async () => { const n = Number((await read(8)).readBigUInt64LE()); if (!Number.isSafeInteger(n)) throw new Error('非法长度'); return n; };
  const str = async () => (await read(await u64())).toString('utf8');
  const value = async (type, depth = 0) => {
    if (depth > 2) throw new Error('元数据嵌套异常');
    if (type === 8) return str();
    if (type === 9) { const t = await u32(), n = await u64(); if (n > 500000) throw new Error('数组过大'); for (let i=0;i<n;i++) await value(t, depth+1); return undefined; }
    const sizes = {0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
    if (!sizes[type]) throw new Error('未知 GGUF 类型');
    const b = await read(sizes[type]);
    return type === 7 ? b[0] !== 0 : type === 4 ? b.readUInt32LE() : undefined;
  };
  try {
    if ((await read(4)).toString() !== 'GGUF') throw new Error('不是有效的 GGUF');
    const version = await u32(); if (![2,3].includes(version)) throw new Error('不支持的 GGUF 版本');
    await u64(); const count = await u64(); if (count > 100000) throw new Error('元数据项过多');
    const meta = {};
    for (let i=0;i<count;i++) { const key = await str(), type = await u32(); const v = await value(type); if (/^(general\.|clip\.|split\.)/.test(key)) meta[key] = v; }
    return meta;
  } finally { await h.close(); }
}

export async function scanModels(roots) {
  const models = [], warnings = [], visited = new Set();
  async function walk(dir) {
    let real;
    try { real = await fs.realpath(dir); if (visited.has(real.toLowerCase())) return; visited.add(real.toLowerCase()); }
    catch (e) { warnings.push(`${dir}：${e.message}`); return; }
    let entries;
    try { entries = await fs.readdir(real, {withFileTypes:true}); } catch(e) { warnings.push(`${real}：${e.message}`); return; }
    for (const entry of entries) {
      const file = path.join(real, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !/\.(gguf|safetensors|bin)$/i.test(entry.name)) continue;
      if (/\.bin$/i.test(entry.name) && !/(model|pytorch|ggml)/i.test(entry.name)) continue;
      let meta = {}, error = '';
      if (/\.gguf$/i.test(entry.name)) try { meta = await ggufMetadata(file); } catch(e) { error = e.message; }
      const projector = /mmproj|projector/i.test(entry.name) || meta['general.architecture'] === 'clip' || meta['clip.has_vision_encoder'] !== undefined || meta['clip.has_audio_encoder'] !== undefined;
      const shard = entry.name.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
      const stat = await fs.stat(file);
      models.push({path:file, name:entry.name, size:stat.size, kind:projector?'mmproj':'base', architecture:meta['general.architecture']||'未知', modelName:meta['general.name']||'', vision:meta['clip.has_vision_encoder']===true, audio:meta['clip.has_audio_encoder']===true, runnable:/\.gguf$/i.test(entry.name)&&!error&&(!shard||Number(shard[1])===1), error, shard:shard?`${Number(shard[1])}/${Number(shard[2])}`:'', suggestions:[]});
    }
  }
  for (const root of roots) await walk(root);
  for (const model of models.filter(m=>m.kind==='base')) {
    const tokens = model.name.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>2&&!['gguf','model','f16','q4','q8'].includes(t));
    model.suggestions = models.filter(m=>m.kind==='mmproj'&&m.runnable).map(m=>({path:m.path,score:(path.dirname(m.path)===path.dirname(model.path)?5:0)+tokens.filter(t=>m.name.toLowerCase().includes(t)).length})).filter(m=>m.score>0).sort((a,b)=>b.score-a.score).map(m=>m.path);
  }
  return {models,warnings,scannedAt:new Date().toISOString()};
}
