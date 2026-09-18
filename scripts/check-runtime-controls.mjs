import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const base='http://127.0.0.1:3210';
const post=async(url,route,data={})=>{const r=await fetch(url+'/api/'+route,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-H3-Local':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
const state=await(await fetch(base+'/api/state')).json();assert.equal(state.busy,false);
const report={testedAt:new Date().toISOString(),device:state.settings.device};
const stream=await fetch(base+'/api/generate/stream',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-H3-Local':'1'},body:JSON.stringify({mode:'T2VA',duration:10,outputFormat:'structured',script:'兼容性测试：扩写雨夜车站剧情，详细写出每个动作的镜头、色彩、灯光和声音，至少写3000字。',language:'zh'}),signal:AbortSignal.timeout(20000)});
assert.equal(stream.status,200);const reader=stream.body.getReader();let collected='',cancelled=false;
while(true){const {value,done}=await reader.read();if(done)break;collected+=new TextDecoder().decode(value);if(!cancelled&&collected.includes('"type":"delta"')){await post(base,'cancel');cancelled=true;}}
assert.equal(cancelled,true);assert.match(collected,/"type":"cancelled"/);assert.doesNotMatch(collected,/"type":"done"/);report.earlyStop='passed: received partial output, cancelled request, no completion';console.log(report.earlyStop);
const freePort=async()=>{const srv=http.createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;await new Promise(r=>srv.close(r));return port;};
const appPort=await freePort(),modelPort=await freePort(),url=`http://127.0.0.1:${appPort}`,modelUrl=`http://127.0.0.1:${modelPort}`;
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-live-lifecycle-'));
await fs.writeFile(path.join(temp,'settings.json'),JSON.stringify({...state.settings,endpoint:modelUrl,contextSize:2048,maxTokens:128}));
const proc=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','windows-console.ps1','-NoBrowser','-NoHold'],{windowsHide:true,env:{...process.env,PORT:String(appPort),H3_DATA_DIR:temp},stdio:['ignore','pipe','pipe']});
let log='';proc.stdout.on('data',d=>log+=d);proc.stderr.on('data',d=>log+=d);
async function online(address,route){try{return (await fetch(address+route,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}}
async function until(check,seconds){for(let i=0;i<seconds*5;i++){if(await check())return true;await new Promise(r=>setTimeout(r,200));}return false;}
try{
  assert.ok(await until(()=>online(url,'/api/state'),15),log);
  await post(url,'scan');await post(url,'model/start');
  assert.ok(await until(()=>online(modelUrl,'/health'),45),'测试模型启动失败：'+log);
  console.log('独立控制台及真实 GPU 模型已加载，开始模拟强制关闭控制台。');
  proc.kill();
  assert.ok(await until(async()=>!await online(url,'/api/state')&&!await online(modelUrl,'/health'),10),'关闭控制台后存在残留服务');
  report.consoleClose='passed: killed console owner, both application and real llama-server stopped';console.log(report.consoleClose);
}finally{
  await post(url,'shutdown').catch(()=>{});proc.kill();
  if(path.dirname(temp)!==os.tmpdir()||!path.basename(temp).startsWith('h3-live-lifecycle-'))throw new Error('临时目录异常');
  await fs.rm(temp,{recursive:true,force:true});
  await fs.writeFile('data/runtime-controls-report.json',JSON.stringify(report,null,2));
}
