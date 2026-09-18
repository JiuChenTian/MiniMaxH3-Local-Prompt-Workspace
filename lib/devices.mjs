import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveExecutable} from './tool-paths.mjs';
const exec=promisify(execFile);
export function parseDevices(text){
  const devices=[];
  for(const line of text.split(/\r?\n/)){
    const m=line.match(/^\s*([A-Za-z][\w.-]*\d+)\s*:\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/i);
    if(m)devices.push({id:m[1],name:m[2].trim(),memoryMiB:Number(m[3]),freeMiB:Number(m[4]),label:`${m[2].trim()} · ${(Number(m[3])/1024).toFixed(1)} GB`});
  }
  // Identical models remain distinguishable without replacing the product name.
  for(const d of devices)if(devices.filter(x=>x.name===d.name).length>1)d.label+=` · ${d.id}`;
  return devices;
}
export async function detectDevices(serverPath){
  if(!serverPath)throw new Error('请先填写并选择 llama-server 程序路径');
  const exe=await resolveExecutable(serverPath,'llama-server.exe');
  const {stdout,stderr}=await exec(exe,['--list-devices'],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  return {devices:parseDevices(stdout+'\n'+stderr),serverPath:exe};
}
export function deviceArgs(id,devices){
  if(id==='cpu')return ['--device','none','-ngl','0','--no-mmproj-offload'];
  if(id==='auto')return ['-ngl','auto'];
  if(!devices.some(d=>d.id===id))throw new Error('所选 GPU 已不可用，请重新识别并选择显卡');
  return ['--device',id,'-ngl','all'];
}
