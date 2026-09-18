import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
export async function isWorkbench(url) {
  try {
    const response=await fetch(url+'/api/state',{signal:AbortSignal.timeout(1500),redirect:'error'});
    if(!response.ok)return false;
    const data=await response.json();
    // Also recognize the first release, which did not have an application ID.
    return data.app==='h3-local-prompt-studio'||
      (Array.isArray(data.settings?.roots)&&Array.isArray(data.catalog?.models)&&Array.isArray(data.modes?.cinematic)&&Array.isArray(data.modes?.storyboard));
  } catch {return false;}
}
function openBrowser(url) {
  if(process.argv.includes('--no-browser'))return;
  const program=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const browser=spawn(program,args,{windowsHide:true,stdio:'ignore'});
  browser.on('error',()=>console.log(`请手动打开：${url}`));browser.unref();
}
async function post(url,route,data={}) {
  const response=await fetch(url+'/api/'+route,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-H3-Local':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('工作台控制接口不可用，请关闭旧版服务后重新启动');
  return response.json();
}
export async function main() {
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('请安装 Node.js 22 或更新版本。');
  const port=Number(process.env.PORT||3210);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须是 1–65535 之间的端口号。');
  const url='http://127.0.0.1:'+port;
  let child=null,ended=false,stopRequested=false;
  if(await isWorkbench(url)){
    console.log('工作台已在运行，直接打开：'+url);
    if(process.argv.includes('--check-only'))return;
  }else{
    if(process.argv.includes('--check-only'))throw new Error('工作台未运行');
    child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:process.env,windowsHide:true,stdio:['inherit','inherit','inherit','ipc']});
    let spawnError;
    child.once('error',e=>{spawnError=e;ended=true;});child.once('exit',()=>ended=true);
    let ready=false;
    for(let i=0;i<60&&!ended;i++){if(await isWorkbench(url)){ready=true;break;}await new Promise(r=>setTimeout(r,250));}
    if(!ready){child.kill();throw spawnError||new Error('工作台未能启动；请检查端口 '+port+' 是否被其他软件占用。');}
  }
  const session=await post(url,'console/open');
  const stop=()=>{stopRequested=true;post(url,'shutdown').catch(()=>child?.kill());};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log('控制台保持运行；关闭这个窗口即停止工作台和本软件启动的模型。Ctrl+C 也可停止。');
  openBrowser(url);
  try{
    while(!ended&&!stopRequested){await new Promise(r=>setTimeout(r,1500));try{await post(url,'console/ping',{id:session.id});}catch{break;}}
    if(stopRequested)await post(url,'shutdown').catch(()=>{});
  }finally{
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    if(child?.connected)child.disconnect();
    console.log('工作台已停止。');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
