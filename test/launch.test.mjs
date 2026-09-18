import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isWorkbench} from '../launch.mjs';

test('Windows 启动脚本保持 ASCII 和 CRLF 换行',async()=>{
  const b=await fs.readFile(new URL('../启动工作台.bat',import.meta.url));
  assert.ok([...b].every(n=>n<128));
  assert.doesNotMatch(b.toString(),/(?<!\r)\n/);
  assert.match(b.toString(),/windows-console\.ps1/);
});
test('启动器识别新旧工作台，重复启动正常退出，不误认其他服务',async()=>{
  let response={app:'h3-local-prompt-studio'};
  const srv=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const port=srv.address().port,url=`http://127.0.0.1:${port}`;
  try {
    assert.equal(await isWorkbench(url),true);
    response={settings:{roots:[]},catalog:{models:[]},modes:{cinematic:['电影叙事'],storyboard:['分镜']}};
    assert.equal(await isWorkbench(url),true);
    const result=await promisify(execFile)(process.execPath,['launch.mjs','--no-browser','--check-only'],{env:{...process.env,PORT:String(port)},windowsHide:true,timeout:10000});
    assert.match(result.stdout,/工作台已在运行/);assert.equal(result.stderr,'');
    response={message:'another application'};assert.equal(await isWorkbench(url),false);
  } finally {srv.closeAllConnections();await new Promise(r=>srv.close(r));}
});
