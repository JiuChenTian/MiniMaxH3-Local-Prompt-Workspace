import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('端到端：设置、拒绝跨站、生成、历史落盘、取消与错误恢复',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-api-test-'));
  let pending=false,seen=[];
  const model=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'test-engine'}]}));
    if(req.url==='/props')return res.end(JSON.stringify({modalities:{vision:false,audio:false}}));
    let chunks=[];for await(const c of req)chunks.push(c);seen.push(JSON.parse(Buffer.concat(chunks)));
    if(pending)return;
    res.end(JSON.stringify({choices:[{message:{content:'测试输出：雨夜，镜头缓慢推近怀表。'},finish_reason:'stop'}]}));
  });
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const app=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),H3_DATA_DIR:temp},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const base=`http://127.0.0.1:${port}`;
  const post=(url,obj={},origin=base)=>fetch(base+'/api/'+url,{method:'POST',headers:{Origin:origin,'X-H3-Local':'1','Content-Type':'application/json'},body:JSON.stringify(obj)});
  try{
    await Promise.race([once(app.stdout,'data'),new Promise((_,rej)=>{const t=setTimeout(()=>rej(new Error('server startup timeout')),10000);t.unref();})]);
    assert.equal((await fetch(base)).status,200);
    assert.equal((await post('cancel',{},'https://other.example')).status,403);
    let state=await (await fetch(base+'/api/state')).json();
    const saved=await post('settings',{...state.settings,endpoint:`http://127.0.0.1:${model.address().port}`});assert.equal(saved.status,200);
    assert.equal((await post('scan')).status,200);
    const input={script:'雨夜，修表师打开怀表',duration:10,mode:'cinematic',linkContext:false,context:'不应进入请求的前情',assets:[]};
    const generated=await (await post('generate',input)).json();assert.match(generated.output,/雨夜/);assert.doesNotMatch(JSON.stringify(seen),/不应进入请求的前情/);
    const records=await (await fetch(base+'/api/history')).json();assert.equal(records.length,1);assert.equal(records[0].output,generated.output);
    const failed=await post('generate',{...input,mode:'REF2VA',assets:[{name:'photo.png',role:'主体身份',data:'AA=='}]});assert.equal(failed.status,400);assert.match((await failed.json()).error,/不支持/);
    pending=true;const inFlight=post('generate',input);for(let i=0;i<100;i++){state=await(await fetch(base+'/api/state')).json();if(state.busy)break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.busy,true);
    assert.equal((await post('generate',input)).status,400);
    await post('cancel');assert.equal((await inFlight).status,400);
    state=await(await fetch(base+'/api/state')).json();assert.equal(state.busy,false);
  }finally{
    app.kill();await once(app,'exit');model.closeAllConnections();await new Promise(r=>model.close(r));await fs.rm(temp,{recursive:true,force:true});
  }
});
