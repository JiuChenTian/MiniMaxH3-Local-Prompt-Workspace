import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function localURL(value) {
  const u = new URL(value);
  if (u.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error('模型服务地址必须为本机 http://127.0.0.1:端口 或 localhost 地址');
  return u.href.replace(/\/$/,'').replace(/\/v1$/,'');
}
export async function probe(endpoint) {
  const base = localURL(endpoint);
  const r = await fetch(base+'/v1/models',{signal:AbortSignal.timeout(5000),redirect:'error'});
  if (!r.ok) throw new Error(`模型服务尚未就绪（${r.status}）`);
  const models = (await r.json()).data || [];
  let props = {};
  try { const p=await fetch(base+'/props',{signal:AbortSignal.timeout(5000),redirect:'error'}); if(p.ok) props=await p.json(); } catch {}
  return {connected:true,models:models.map(m=>m.id),vision:props.modalities?.vision===true,audio:props.modalities?.audio===true,known:!!props.modalities,modelPath:props.model_path||''};
}
export async function complete(endpoint, model, messages, options, signal, onDelta) {
  const r=await fetch(localURL(endpoint)+'/v1/chat/completions',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:options.temperature,max_tokens:options.maxTokens,stream:!!onDelta}),signal});
  if (!r.ok) throw new Error(`本地模型返回 ${r.status}：${(await r.text()).slice(0,700)}`);
  if(onDelta&&r.headers.get('content-type')?.includes('text/event-stream'))return consumeSSE(r.body,onDelta,signal);
  const result=await r.json(); const output=result.choices?.[0]?.message?.content;
  if(typeof output!=='string'||!output.trim()) throw new Error('模型未返回提示词；请检查聊天模板或增加输出长度');
  if(onDelta)onDelta(output);
  return {output,usage:result.usage||null,truncated:result.choices[0].finish_reason==='length'};
}
export async function consumeSSE(body,onDelta,signal){
  let buffer='',output='',usage=null,finish=null,done=false;const decoder=new TextDecoder();
  function line(raw){
    if(!raw.startsWith('data:'))return;
    const payload=raw.slice(5).trim();if(!payload)return;if(payload==='[DONE]'){done=true;return;}
    const data=JSON.parse(payload);if(data.error)throw new Error(data.error.message||'模型流式输出失败');
    const delta=data.choices?.[0]?.delta?.content;
    if(typeof delta==='string'){output+=delta;onDelta(delta);}
    if(data.usage)usage=data.usage;if(data.choices?.[0]?.finish_reason)finish=data.choices[0].finish_reason;
  }
  for await(const chunk of body){signal?.throwIfAborted();buffer+=decoder.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i).replace(/\r$/,''));buffer=buffer.slice(i+1);}}
  buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());signal?.throwIfAborted();
  if(!done&&!finish)throw new Error('模型连接中断；已显示内容可能不完整');
  if(!output.trim())throw new Error('模型未返回提示词');
  return {output,usage,truncated:finish==='length'};
}
export function runProcess(executable,args,signal) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],signal}); let err='';
    child.stderr.on('data',d=>{err=(err+d).slice(-3000)});
    child.on('error',e=>reject(new Error(`无法运行 ${executable}：${e.message}`)));
    child.on('close',code=>code===0?resolve():reject(new Error(`媒体转换失败：${err}`)));
  });
}
export async function mediaParts(assets,capabilities,settings,signal) {
  const parts=[];
  for(const [i,a] of assets.entries()) {
    if(a.kind==='image'&&!capabilities.vision) throw new Error(`当前模型不支持或未确认图片识别：${a.name}。请加载视觉模型及匹配的 mmproj。`);
    if(a.kind==='video'&&!capabilities.vision) throw new Error(`当前模型不支持视频画面识别：${a.name}。视频抽帧需要视觉模型。`);
    if(a.kind==='audio'&&!capabilities.audio) throw new Error(`当前模型不支持或未确认音频识别：${a.name}。请切换音频模型，或移除文件并填写文字转录。`);
    parts.push({type:'text',text:`${a.label||`参考素材 ${i+1}`}：${a.name}；职责：${a.role||'辅助理解用户场景'}。`});
    if(a.kind==='image') parts.push({type:'image_url',image_url:{url:`data:${a.mime};base64,${a.data}`}});
    if(a.kind==='audio') {
      if(['wav','mp3','flac'].includes(a.ext)) parts.push({type:'input_audio',input_audio:{data:a.data,format:a.ext}});
      else {
        const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-audio-'));
        try {const src=path.join(tmp,`input.${a.ext}`), out=path.join(tmp,'output.wav'); await fs.writeFile(src,Buffer.from(a.data,'base64')); await runProcess(settings.ffmpeg||'ffmpeg',['-nostdin','-v','error','-i',src,'-vn','-ac','1','-ar','16000','-t','120',out],signal); parts.push({type:'input_audio',input_audio:{data:(await fs.readFile(out)).toString('base64'),format:'wav'}});}
        finally {await fs.rm(tmp,{recursive:true,force:true});}
      }
    }
    if(a.kind==='video') {
      const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'h3-video-'));
      try {
        const src=path.join(tmp,`input.${a.ext}`); await fs.writeFile(src,Buffer.from(a.data,'base64'));
        // Six samples in the first 15 seconds: explicit, reproducible, bounded.
        await runProcess(settings.ffmpeg||'ffmpeg',['-nostdin','-v','error','-i',src,'-t','15','-vf','fps=2/5,scale=768:768:force_original_aspect_ratio=decrease','-frames:v','6',path.join(tmp,'frame-%02d.jpg')],signal);
        const frames=(await fs.readdir(tmp)).filter(n=>n.endsWith('.jpg')).sort();
        if(!frames.length) throw new Error('视频中未能提取画面，请使用更长的视频或转换为 MP4');
        parts.push({type:'text',text:'以下是视频前 15 秒内按 2.5 秒间隔采样的画面（最多 6 张），按顺序分析；未提供视频声音，采样无法完整反映动作。'});
        for(const f of frames) parts.push({type:'image_url',image_url:{url:`data:image/jpeg;base64,${(await fs.readFile(path.join(tmp,f))).toString('base64')}`}});
      } finally {await fs.rm(tmp,{recursive:true,force:true});}
    }
  }
  return parts;
}
