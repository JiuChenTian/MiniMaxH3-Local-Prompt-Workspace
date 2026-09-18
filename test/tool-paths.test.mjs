import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveExecutable,normalizeToolPaths} from '../lib/tool-paths.mjs';

test('多个程序路径、目录及 bin 识别、去重和旧设置迁移',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'h3-path-test-'));
  try{
    const first=path.join(root,'first'),second=path.join(root,'second');
    await fs.mkdir(path.join(first,'bin'),{recursive:true});await fs.mkdir(second);
    const ffmpeg=path.join(first,'bin','ffmpeg.exe'),server=path.join(second,'llama-server.exe');
    await fs.writeFile(ffmpeg,'fixture');await fs.writeFile(server,'fixture');
    assert.equal(await resolveExecutable(first,'ffmpeg.exe'),ffmpeg);
    const s=await normalizeToolPaths({serverPaths:[second,server],serverPath:second,ffmpegPaths:[first,ffmpeg],ffmpeg:first});
    assert.deepEqual(s.serverPaths,[server]);assert.deepEqual(s.ffmpegPaths,[ffmpeg]);assert.equal(s.serverPath,server);assert.equal(s.ffmpeg,ffmpeg);
    const old=await normalizeToolPaths({serverPath:server,ffmpeg});assert.deepEqual(old.serverPaths,[server]);
    const inactive=await normalizeToolPaths({serverPaths:[second],serverPath:'',ffmpegPaths:[first],ffmpeg:''});assert.equal(inactive.serverPath,'');assert.equal(inactive.ffmpeg,'');
    await assert.rejects(()=>resolveExecutable('relative','ffmpeg.exe'),/完整路径/);
    await assert.rejects(()=>resolveExecutable(second,'ffmpeg.exe'),/未找到/);
    await assert.rejects(()=>normalizeToolPaths({serverPaths:Array(21).fill(second)}),/20/);
    assert.equal(await fs.readFile(ffmpeg,'utf8'),'fixture');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
