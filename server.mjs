import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {scanModels} from './lib/scanner.mjs';
import {MODES,STYLES,buildMessages,validateModeAssets,normalizeMode,translationMessages} from './lib/prompts.mjs';
import {localURL,probe,complete,mediaParts} from './lib/inference.mjs';
import {normalizeToolPaths} from './lib/tool-paths.mjs';
import {detectDevices,deviceArgs} from './lib/devices.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.H3_DATA_DIR||path.join(ROOT,'data'); await fs.mkdir(DATA,{recursive:true});
const defaults={roots:[],endpoint:'http://127.0.0.1:8080',serverPath:'',serverPaths:[],ffmpeg:'',ffmpegPaths:[],baseModel:'',mmproj:'',device:'auto',gpuLayers:0,contextSize:8192,temperature:0.7,maxTokens:2048};
let settings={...defaults};
try {settings={...defaults,...JSON.parse(await fs.readFile(path.join(DATA,'settings.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT') console.warn('设置文件读取失败，将使用默认设置：',e.message);}
let catalog={models:[],warnings:[]}, child=null, log='', generation=null, scanning=null;
let stopping=null,starting=false,closing=false;const consoles=new Map();
const PORT=Number(process.env.PORT||3210);
const json=(res,obj,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
async function body(req) {let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>90*1024*1024)throw new Error('上传内容总量超过 90 MB');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
async function save(file,data){const out=path.join(DATA,file),tmp=out+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,out);}
async function history(){try{return JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function validateSettings(data){
  const s={...defaults,...data};
  if(!Array.isArray(s.roots)||s.roots.length>30||s.roots.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('模型目录必须为完整路径，最多 30 个');
  s.roots=[...new Set(s.roots.map(p=>p.trim()).filter(Boolean))];s.endpoint=localURL(s.endpoint);
  if(typeof s.device!=='string'||!/^([A-Za-z][\w.-]*\d+|auto|cpu)$/.test(s.device))throw new Error('无效的推理设备，请重新识别 GPU');
  for(const key of ['serverPath','ffmpeg','baseModel','mmproj'])if(typeof s[key]!=='string')throw new Error('无效的路径设置');
  for(const [key,min,max] of [['gpuLayers',0,999],['contextSize',2048,131072],['maxTokens',128,16384],['temperature',0,2]]){s[key]=Number(s[key]);if(!Number.isFinite(s[key])||s[key]<min||s[key]>max||(key!=='temperature'&&!Number.isInteger(s[key])))throw new Error(`${key} 超出范围 ${min}–${max}`);}
  if(s.maxTokens>=s.contextSize)throw new Error('输出长度必须小于上下文长度');
  return normalizeToolPaths(Object.fromEntries(Object.keys(defaults).map(k=>[k,s[k]])));
}
const extensions={png:['image','image/png'],jpg:['image','image/jpeg'],jpeg:['image','image/jpeg'],webp:['image','image/webp'],bmp:['image','image/bmp'],mp4:['video','video/mp4'],mov:['video','video/quicktime'],mkv:['video','video/x-matroska'],webm:['video','video/webm'],avi:['video','video/x-msvideo'],mp3:['audio','audio/mpeg'],wav:['audio','audio/wav'],flac:['audio','audio/flac'],m4a:['audio','audio/mp4'],ogg:['audio','audio/ogg'],aac:['audio','audio/aac']};
function validateAssets(list){
  if(!Array.isArray(list)||list.length>9)throw new Error('最多添加 9 个参考文件');
  let total=0;
  return list.map(a=>{const name=path.basename(String(a.name||'')),ext=name.split('.').pop().toLowerCase(),type=extensions[ext];if(!type)throw new Error(`不支持的文件格式：${name}`);if(typeof a.data!=='string'||!a.data.length||a.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))throw new Error('媒体数据不完整');const size=Buffer.byteLength(a.data,'base64');total+=size;if(size>25*1024*1024||total>60*1024*1024)throw new Error('单文件最多 25 MB，合计最多 60 MB');return {name,ext,kind:type[0],mime:type[1],data:a.data,role:String(a.role||'').slice(0,500)};});
}
async function scan(){if(!scanning)scanning=scanModels(settings.roots).then(r=>catalog=r).finally(()=>scanning=null);return scanning;}
async function startModel(){
  if(stopping||closing)throw new Error('模型正在停止，请稍后启动');
  if(child)throw new Error('已有本软件启动的模型进程，请先停止再切换');
  if(generation)throw new Error('请先取消正在进行的生成');
  if(!settings.serverPath||!settings.baseModel)throw new Error('请在设置中指定 llama-server 程序，并选择基础模型');
  await fs.access(settings.serverPath); await fs.access(settings.baseModel);
  if(!catalog.models.some(m=>m.path===settings.baseModel&&m.kind==='base'&&m.runnable))throw new Error('所选基础模型不在有效扫描结果中，请重新扫描');
  if(settings.mmproj&&!catalog.models.some(m=>m.path===settings.mmproj&&m.kind==='mmproj'&&m.runnable))throw new Error('所选 mmproj 不在有效扫描结果中');
  const u=new URL(localURL(settings.endpoint));if(u.pathname!=='/')throw new Error('自动启动时服务地址不能带路径');
  try {await probe(settings.endpoint);throw new Error('该地址已经有模型服务运行，请直接连接或更换端口');}catch(e){if(e.message.includes('已经有'))throw e;}
  const devices=settings.device==='cpu'||settings.device==='auto'?[]:(await detectDevices(settings.serverPath)).devices;
  const args=['-m',settings.baseModel,'--host',u.hostname==='[::1]'?'::1':u.hostname,'--port',u.port||'80','-c',String(settings.contextSize),'--parallel','1',...deviceArgs(settings.device,devices)];
  if(settings.mmproj)args.push('--mmproj',settings.mmproj);
  log='';const proc=spawn(settings.serverPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});child=proc;
  proc.stdout.on('data',d=>log=(log+d).slice(-16000));proc.stderr.on('data',d=>log=(log+d).slice(-16000));
  proc.on('exit',(code)=>{log+=`\n进程已退出：${code}`;if(child===proc)child=null;});
  await new Promise((resolve,reject)=>{proc.once('spawn',resolve);proc.once('error',e=>{if(child===proc)child=null;log+=e.message;reject(e);});});
}
async function stopModel(){
  generation?.abort();if(stopping)return stopping;
  const proc=child;if(!proc)return;
  stopping=new Promise(resolve=>{
    if(proc.exitCode!==null){resolve();return;}
    const timer=setTimeout(()=>{proc.kill('SIGKILL');resolve();},5000);
    proc.once('exit',()=>{clearTimeout(timer);resolve();});proc.kill();
  }).finally(()=>{if(child===proc)child=null;stopping=null;});
  return stopping;
}
async function shutdown(){
  if(closing)return;closing=true;console.log('正在停止输出和模型，关闭工作台服务…');
  await stopModel();server.close();server.closeAllConnections();
  setTimeout(()=>process.exit(0),200).unref();
}
const consoleWatch=setInterval(()=>{if([...consoles.values()].some(t=>Date.now()-t>8000))shutdown();},1000);consoleWatch.unref();
async function route(req,res){
  const host=req.headers.host;
  if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(host))return json(res,{error:'无效的本机访问地址'},403);
  if(req.method==='POST'&&(req.headers.origin!==`http://${host}`||req.headers['x-h3-local']!=='1'))return json(res,{error:'只接受本地工作台请求'},403);
  const url=new URL(req.url,`http://${host}`), p=url.pathname;
  if(req.method==='GET'&&p==='/api/state')return json(res,{app:'h3-local-prompt-studio',settings,catalog,modes:MODES,styles:STYLES,running:!!child,starting,stopping:!!stopping,busy:!!generation,log});
  if(req.method==='POST'&&p==='/api/console/open'){const id=randomUUID();consoles.set(id,Date.now());return json(res,{id});}
  if(req.method==='POST'&&p==='/api/console/ping'){const {id}=await body(req);if(!consoles.has(id))throw new Error('控制台会话已失效');consoles.set(id,Date.now());return json(res,{ok:true});}
  if(req.method==='POST'&&p==='/api/shutdown'){json(res,{stopping:true});void shutdown();return;}
  if(req.method==='POST'&&p==='/api/devices'){const data=await body(req);return json(res,await detectDevices(data.serverPath||settings.serverPath));}
  if(req.method==='GET'&&p==='/api/history')return json(res,await history());
  if(req.method==='POST'&&p==='/api/settings'){if(generation||child||starting||stopping)throw new Error('请先停止生成和本软件启动的模型，再修改设置');const s=await validateSettings(await body(req));await save('settings.json',s);settings=s;return json(res,settings);}
  if(req.method==='POST'&&p==='/api/scan')return json(res,await scan());
  if(req.method==='POST'&&p==='/api/probe')return json(res,await probe(settings.endpoint));
  if(req.method==='POST'&&p==='/api/model/start'){if(starting)throw new Error('模型正在启动');starting=true;try{await startModel();return json(res,{started:true});}finally{starting=false;}}
  if(req.method==='POST'&&p==='/api/model/stop'){await stopModel();return json(res,{stopped:true});}
  if(req.method==='POST'&&p==='/api/cancel'){generation?.abort();return json(res,{cancelled:true});}
  if(req.method==='POST'&&['/api/generate','/api/generate/stream','/api/translate'].includes(p)){
    if(generation)throw new Error('已有生成任务进行中');
    if(stopping||closing)throw new Error('服务正在停止');
    const translate=p==='/api/translate';let streaming=p==='/api/generate/stream';
    const controller=new AbortController();generation=controller;
    const timer=setTimeout(()=>controller.abort(new Error('生成超时，请缩短输入或调整模型设置')),600000);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      const input=await body(req);streaming=streaming||(translate&&input.stream===true);
      const assets=translate?[]:validateModeAssets(input,validateAssets(input.assets||[]));
      if(translate)translationMessages(input.text,input.targetLanguage);else buildMessages(input);
      const capabilities=await probe(settings.endpoint);controller.signal.throwIfAborted();
      const parts=await mediaParts(assets,capabilities,settings,controller.signal);
      const model=input.model||capabilities.models[0];
      if(!model||!capabilities.models.includes(model))throw new Error('请选择模型服务当前提供的模型');
      if(streaming){res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});res.flushHeaders();}
      const emit=data=>{if(!res.destroyed)res.write(JSON.stringify(data)+'\n');};
      const result=await complete(settings.endpoint,model,translate?translationMessages(input.text,input.targetLanguage):buildMessages(input,parts),translate?{...settings,temperature:0.1}:settings,controller.signal,streaming?delta=>emit({type:'delta',delta}):undefined);
      controller.signal.throwIfAborted();
      if(translate){if(streaming){emit({type:'done',...result});res.end();return;}return json(res,result);}
      const record={id:randomUUID(),createdAt:new Date().toISOString(),script:input.script,mode:normalizeMode(input.mode),output:result.output,model,linkContext:!!input.linkContext,...Object.fromEntries(['duration','ratio','style','constraints','language','inputType','writingStyle','outputFormat','resolution'].map(k=>[k,input[k]]))};
      const records=await history();records.unshift(record);await save('history.json',records.slice(0,100));
      if(streaming){emit({type:'done',...result,id:record.id});res.end();return;}
      return json(res,{...result,id:record.id});
    } catch(e){
      if(streaming&&res.headersSent){if(!res.destroyed)res.end(JSON.stringify({type:controller.signal.aborted?'cancelled':'error',error:controller.signal.aborted?'已提前终止，保留已输出文字':e.message})+'\n');return;}
      throw e;
    } finally {clearTimeout(timer);if(generation===controller)generation=null;}
  }
  if(req.method==='GET'){
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[p];
    if(file){res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});return res.end(await fs.readFile(path.join(ROOT,'public',file)));}
  }
  json(res,{error:'页面不存在'},404);
}
const server=http.createServer((req,res)=>route(req,res).catch(e=>{console.error(e.message);if(!res.headersSent)json(res,{error:e.name==='AbortError'?'已取消生成':e.message},400);else res.end();}));
server.requestTimeout=660000;
server.listen(PORT,'127.0.0.1',()=>{console.log(`H3 本地提示词工作台：http://127.0.0.1:${PORT}`);scan().catch(e=>console.error(e.message));});
server.on('error',e=>{console.error(`启动失败：${e.message}`);process.exitCode=1;});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,shutdown);
process.on('disconnect',shutdown);
