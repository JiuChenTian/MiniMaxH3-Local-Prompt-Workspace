import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {runProcess} from '../lib/inference.mjs';
const base='http://127.0.0.1:3210';
const state=await(await fetch(base+'/api/state')).json();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-five-modes-'));
const report={testedAt:new Date().toISOString(),results:[]};
async function post(route,data){const r=await fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-H3-Local':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(120000)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;}
try{
  const assets=[];
  for(const color of ['red','blue']){
    const file=path.join(temp,color+'.png');await runProcess(state.settings.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`color=c=${color}:s=160x160`,'-frames:v','1',file],AbortSignal.timeout(10000));
    assets.push({name:color+'.png',role:'背景颜色',data:(await fs.readFile(file)).toString('base64')});
  }
  for(const mode of ['T2VA','I2VA','FL2VA','L2VA','REF2VA']){
    const refs=mode==='T2VA'?[]:mode==='FL2VA'?assets:mode==='L2VA'?[assets[1]]:[assets[0]];
    const result=await post('generate',{mode,duration:5,ratio:refs.length?'adaptive':'16:9',outputFormat:'structured',language:'zh',script:'兼容性测试：简洁的纯色视觉短片，柔和的光线在画面中移动；有首尾图时以平滑色彩变化连接。请简短输出每个结构字段，不超过200字。',assets:refs});
    assert.match(result.output,mode==='REF2VA'?/subject_definitions/:/integrated_multimodal_description/);
    assert.match(result.output,/overall_soundscape/);assert.match(result.output,/non_diegetic_music/);
    report.results.push({mode,...result});console.log(mode+'：结构字段通过');
  }
  const translated=await post('translate',{text:'[Shot 1] At 0.00 seconds, <Picture 1> establishes a red background. The camera remains static.',targetLanguage:'zh'});
  assert.match(translated.output,/<Picture 1>/);assert.match(translated.output,/红/);report.englishToChinese=translated.output;console.log('英译中与参考标签保留通过');
}finally{
  if(path.dirname(temp)!==os.tmpdir()||!path.basename(temp).startsWith('h3-five-modes-'))throw new Error('临时目录异常');
  await fs.rm(temp,{recursive:true,force:true});await fs.writeFile('data/h3-modes-report.json',JSON.stringify(report,null,2));
}
