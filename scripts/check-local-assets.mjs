// Read-only access to supplied model/FFmpeg folders; all generated files live
// in a new system temporary directory or this project's data directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {scanModels} from '../lib/scanner.mjs';
import {mediaParts,runProcess} from '../lib/inference.mjs';

const [modelDir,ffmpeg]=process.argv.slice(2);
if(!modelDir||!ffmpeg)throw new Error('需要模型目录与 ffmpeg.exe 路径');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function snapshot(dir){const result=[];for(const name of (await fs.readdir(dir)).sort()){const p=path.join(dir,name),s=await fs.stat(p);if(s.isDirectory())result.push(...await snapshot(p));else result.push({path:p,size:s.size,mtime:s.mtimeMs});}return result;}
const before=await snapshot(modelDir),ffBefore=await fs.stat(ffmpeg);
const catalog=await scanModels([modelDir]);
assert.equal(catalog.warnings.length,0);
assert.ok(catalog.models.some(m=>m.kind==='base'&&m.runnable));
assert.ok(catalog.models.some(m=>m.kind==='mmproj'&&m.runnable));
console.log(JSON.stringify(catalog,null,2));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-local-smoke-'));
const signal=AbortSignal.timeout(90000);
let report;
try {
  await runProcess(ffmpeg,['-version'],signal);
  const video=path.join(temp,'sample.mp4'),audio=path.join(temp,'sample.m4a');
  await runProcess(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','15','-c:v','libx264','-pix_fmt','yuv420p',video],signal);
  await runProcess(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','aac',audio],signal);
  const asset=async(file,kind,ext)=>({name:path.basename(file),kind,ext,data:(await fs.readFile(file)).toString('base64')});
  const videoParts=await mediaParts([await asset(video,'video','mp4')],{vision:true},{ffmpeg},signal);
  const frames=videoParts.filter(p=>p.type==='image_url');assert.equal(frames.length,6);
  for(const frame of frames){const bytes=Buffer.from(frame.image_url.url.split(',')[1],'base64');assert.equal(bytes.readUInt16BE(0),0xffd8);}
  // Conversion check only: this does not claim that the user's model supports audio.
  const audioParts=await mediaParts([await asset(audio,'audio','m4a')],{audio:true},{ffmpeg},signal);
  const wav=Buffer.from(audioParts.find(p=>p.type==='input_audio').input_audio.data,'base64');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
  await assert.rejects(()=>mediaParts([awaitAssetPlaceholder()],{audio:false},{ffmpeg},signal),/不支持/);
  report={testedAt:new Date().toISOString(),modelDir,ffmpeg,models:catalog.models,videoFrames:frames.length,audioConversion:'M4A → WAV passed (pipeline only, not model inference)',unsupportedAudio:'blocked correctly',inference:'not tested: llama-server executable required',modelFilesUnchanged:true};
} finally {
  // This target is created above under the system temp directory, never user assets.
  if(path.dirname(temp)!==os.tmpdir()||!path.basename(temp).startsWith('h3-local-smoke-'))throw new Error('临时路径不符合清理条件');
  await fs.rm(temp,{recursive:true,force:true});
  assert.deepEqual(await snapshot(modelDir),before,'模型文件目录、大小或修改时间发生变化');
  const ffAfter=await fs.stat(ffmpeg);assert.equal(ffAfter.size,ffBefore.size);assert.equal(ffAfter.mtimeMs,ffBefore.mtimeMs);
}
function awaitAssetPlaceholder(){return {kind:'audio',name:'unsupported.wav',ext:'wav',data:'AA=='};}
await fs.mkdir(path.join(root,'data'),{recursive:true});
await fs.writeFile(path.join(root,'data','local-smoke-report.json'),JSON.stringify(report,null,2));
console.log('PASS: 6 video frames; M4A → WAV; unsupported audio rejected; source file metadata unchanged.');
