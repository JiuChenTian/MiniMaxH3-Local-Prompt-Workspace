import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('Windows 控制台进程被关闭后，所属工作台服务自动退出',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-job-test-'));
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const proc=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','windows-console.ps1','-NoBrowser','-NoHold'],{windowsHide:true,env:{...process.env,PORT:String(port),H3_DATA_DIR:temp},stdio:['ignore','pipe','pipe']});
  let log='';proc.stdout.on('data',d=>log+=d);proc.stderr.on('data',d=>log+=d);
  const online=async()=>{try{const r=await fetch(`http://127.0.0.1:${port}/api/state`,{signal:AbortSignal.timeout(500)});return r.ok;}catch{return false;}};
  try{
    let ready=false;for(let i=0;i<100;i++){if(await online()){ready=true;break;}if(proc.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(ready,true,log);
    proc.kill();let stopped=false;for(let i=0;i<70;i++){if(!await online()){stopped=true;break;}await new Promise(r=>setTimeout(r,100));}
    assert.equal(stopped,true,'关闭控制台后服务仍在运行');
  }finally{proc.kill();await fs.rm(temp,{recursive:true,force:true});}
});
