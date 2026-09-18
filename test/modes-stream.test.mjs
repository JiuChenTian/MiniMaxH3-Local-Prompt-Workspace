import test from 'node:test';
import assert from 'node:assert/strict';
import {MODES,buildMessages,validateModeAssets,translationMessages} from '../lib/prompts.mjs';
import {parseDevices,deviceArgs} from '../lib/devices.mjs';
import {consumeSSE} from '../lib/inference.mjs';

test('五种生成模式具有独立锚点与结构',()=>{
  assert.deepEqual(Object.keys(MODES),['T2VA','I2VA','FL2VA','L2VA','REF2VA']);
  const text=mode=>buildMessages({mode,script:'雨夜车站',duration:10})[0].content;
  assert.match(text('I2VA'),/<Picture 1> 对齐 0 秒/);
  assert.match(text('FL2VA'),/<Picture 2> 对齐 10 秒/);
  assert.match(text('L2VA'),/<Picture 1> 对齐 10 秒/);
  assert.match(text('REF2VA'),/subject_definitions、summary、retention_analysis、detailed_description/);
  assert.doesNotMatch(text('T2VA'),/subject_definitions/);
});
test('锚点数量、参考职责与混合编号校验',()=>{
  const img={kind:'image',name:'x.png',role:'身份'};
  assert.throws(()=>validateModeAssets({mode:'T2VA'},[img]),/纯文字/);
  assert.throws(()=>validateModeAssets({mode:'FL2VA'},[img]),/两张/);
  const anchors=validateModeAssets({mode:'FL2VA'},[img,img]);assert.match(anchors[0].role,/首帧/);assert.match(anchors[1].role,/尾帧/);
  assert.throws(()=>validateModeAssets({mode:'REF2VA'},[{...img,role:''}]),/职责/);
  const refs=validateModeAssets({mode:'REF2VA'},[img,{kind:'video',role:'运镜'},img]);assert.deepEqual(refs.map(r=>r.label),['<Picture 1>','<Video 1>','<Picture 2>']);
});
test('GPU 型号来自动态设备列表，禁止失效设备与注入',()=>{
  const devices=parseDevices('Available devices:\n  CUDA0: NVIDIA GeForce RTX 5090 (32579 MiB, 30994 MiB free)\n  Vulkan1: AMD Radeon RX 7900 XTX (24576 MiB, 20000 MiB free)');
  assert.equal(devices[0].name,'NVIDIA GeForce RTX 5090');assert.equal(devices[1].name,'AMD Radeon RX 7900 XTX');
  assert.deepEqual(deviceArgs('Vulkan1',devices),['--device','Vulkan1','-ngl','all']);
  assert.throws(()=>deviceArgs('CUDA9',devices));assert.throws(()=>deviceArgs('CUDA0 --anything',devices));
  assert.ok(deviceArgs('cpu',[]).includes('--no-mmproj-offload'));
});
test('翻译保留源内容并独立指定语言',()=>{
  const messages=translationMessages('integrated_multimodal_description:\n<Picture 1> 红色汽车。','en');
  assert.match(messages[0].content,/英文/);assert.equal(messages[1].content,'integrated_multimodal_description:\n<Picture 1> 红色汽车。');
  assert.throws(()=>translationMessages('','zh'));assert.throws(()=>translationMessages('test','fr'));
});
test('流式解析支持分割 UTF-8、usage 与正常结束',async()=>{
  const bytes=Buffer.from('data: {"choices":[{"delta":{"content":"镜头"}}]}\n\ndata: {"choices":[{"delta":{"content":"推进"},"finish_reason":"stop"}],"usage":{"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  async function* chunks(){for(let i=0;i<bytes.length;i+=3)yield bytes.subarray(i,i+3);}
  let result='';const response=await consumeSSE(chunks(),s=>result+=s,new AbortController().signal);assert.equal(result,'镜头推进');assert.equal(response.output,result);assert.equal(response.usage.completion_tokens,4);
});
test('流式中途断线不伪装完成，取消后不追加文字',async()=>{
  async function* broken(){yield Buffer.from('data: {"choices":[{"delta":{"content":"部分"}}]}\n');}
  await assert.rejects(()=>consumeSSE(broken(),()=>{},new AbortController().signal),/中断/);
  const controller=new AbortController();let text='';async function* chunks(){yield Buffer.from('data: {"choices":[{"delta":{"content":"第一段"}}]}\n');controller.abort();yield Buffer.from('data: {"choices":[{"delta":{"content":"不应出现"}}]}\n');}
  await assert.rejects(()=>consumeSSE(chunks(),d=>text+=d,controller.signal));assert.equal(text,'第一段');
});
