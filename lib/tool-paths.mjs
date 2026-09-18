import fs from 'node:fs/promises';
import path from 'node:path';

export async function resolveExecutable(input, name) {
  const value=String(input).trim().replace(/^"(.*)"$/,'$1');
  if(!path.isAbsolute(value))throw new Error(`${name} 需要完整路径：${value}`);
  let stat;
  try{stat=await fs.stat(value);}catch{throw new Error(`路径不存在：${value}`);}
  const candidates=stat.isDirectory()?[path.join(value,name),path.join(value,'bin',name)]:[value];
  for(const candidate of candidates){
    if(path.basename(candidate).toLowerCase()!==name.toLowerCase())continue;
    try{if((await fs.stat(candidate)).isFile())return path.resolve(candidate);}catch{}
  }
  throw new Error(`未找到 ${name}：${value}（检查所填目录及 bin 子目录）`);
}
export async function normalizeToolPaths(settings) {
  const out={...settings};
  for(const [key,listKey,name] of [['serverPath','serverPaths','llama-server.exe'],['ffmpeg','ffmpegPaths','ffmpeg.exe']]){
    const entries=settings[listKey]??[];
    if(!Array.isArray(entries)||entries.length>20||entries.some(p=>typeof p!=='string'))throw new Error(`${name} 最多保存 20 个路径`);
    const raw=[...new Set([...entries,settings[key]||''].map(p=>p.trim()).filter(Boolean))];
    const resolved=[];
    for(const value of raw)resolved.push(await resolveExecutable(value,name));
    out[listKey]=[...new Map(resolved.map(p=>[process.platform==='win32'?p.toLowerCase():p,p])).values()];
    out[key]=settings[key]?await resolveExecutable(settings[key],name):'';
  }
  return out;
}
