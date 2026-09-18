import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {runProcess} from '../lib/inference.mjs';

const base='http://127.0.0.1:3210';
const post=async(route,data)=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-H3-Local':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(600000)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
const state=await(await fetch(base+'/api/state')).json();
const files=await Promise.all((await fs.readdir(state.settings.roots.at(-1))).map(async n=>{const p=path.join(state.settings.roots.at(-1),n),s=await fs.stat(p);return {path:p,size:s.size,mtime:s.mtimeMs};}));
const caps=await post('probe',{});console.log('服务能力',JSON.stringify(caps));assert.equal(caps.vision,true);
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-live-model-'));
const report={testedAt:new Date().toISOString(),capabilities:caps,results:[]};
try{
  const image=path.join(tmp,'red.png'),video=path.join(tmp,'red.mp4');
  await runProcess(state.settings.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x160','-frames:v','1',image],AbortSignal.timeout(10000));
  await runProcess(state.settings.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x160:r=5','-t','3','-c:v','libx264','-pix_fmt','yuv420p',video],AbortSignal.timeout(10000));
  for(const [name,script,asset] of [
    ['text','本地兼容性测试：修表师在雨夜打开怀表。请扩写为一句不超过80字的中文视频提示词。',null],
    ['image','本地兼容性测试：请依据参考图片的主要颜色，写一句不超过50字的纯色背景视频提示词，不要添加人物。',image],
    ['video','本地兼容性测试：请依据参考视频中画面的主要颜色，写一句不超过50字的背景视频提示词，不要添加人物。',video]
  ]){
    console.log('开始真实测试：'+name);
    const t=Date.now();const result=await post('generate',{script,mode:asset?'REF2VA':'T2VA',outputFormat:'quick',duration:5,ratio:'16:9',language:'zh',linkContext:false,assets:asset?[{name:path.basename(asset),role:'背景颜色',data:(await fs.readFile(asset)).toString('base64')}]:[]});
    assert.ok(result.output.length>0);report.results.push({name,seconds:(Date.now()-t)/1000,...result});console.log(name,JSON.stringify(result));
  }
  if(!caps.audio){await assert.rejects(()=>post('generate',{script:'本地兼容性测试：音频能力检查',mode:'REF2VA',duration:5,assets:[{name:'sample.wav',role:'环境声音',data:'AA=='}]}),/不支持/);report.audio='服务未声明音频能力；工作台正确阻止音频识别';}
}finally{
  if(path.dirname(tmp)!==os.tmpdir()||!path.basename(tmp).startsWith('h3-live-model-'))throw new Error('临时路径异常');
  await fs.rm(tmp,{recursive:true,force:true});
  for(const before of files){const s=await fs.stat(before.path);assert.equal(s.size,before.size);assert.equal(s.mtimeMs,before.mtime);}
  report.modelFilesUnchanged=true;
  await fs.writeFile('data/live-model-report.json',JSON.stringify(report,null,2));
}
console.log('真实模型兼容性测试完成。');
