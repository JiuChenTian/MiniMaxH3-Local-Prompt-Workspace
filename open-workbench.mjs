// Started by the console BEFORE it joins the service Job Object, so opening a
// new browser cannot make that browser part of the model's termination group.
import {spawn} from 'node:child_process';
import {isWorkbench} from './launch.mjs';
const port=Number(process.argv[2]),owner=Number(process.argv[3]);
if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(owner))process.exit(1);
const url=`http://127.0.0.1:${port}`;
for(let i=0;i<60;i++){
  try{process.kill(owner,0);}catch{break;}
  if(await isWorkbench(url)){
    const proc=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});proc.on('error',()=>{});proc.unref();break;
  }
  await new Promise(r=>setTimeout(r,250));
}
