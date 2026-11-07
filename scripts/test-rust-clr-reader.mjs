// Uses existing fixture outputs and dependency caches. Never copies project
// trees, readers or self-contained runtimes into a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), arch=process.argv.includes('--x86')?'win-x86':'win-x64';
const configuration=process.argv.includes('--release')?'release':'debug';
const fixturePath=path.join(root,`scripts/fixtures/snr-reader/Host/bin/Release/net8.0/${arch}/Among Us.exe`);
const rustPath=path.join(root,`src-tauri/target/${arch==='win-x86'?'i686-pc-windows-msvc/':''}${configuration}/tbcl-clr-reader.exe`);
const csharpPath=path.join(root,`out/tauri-backend/out/debug-reader/${arch==='win-x64'?'x64/':''}SnrRoleReader.exe`);
const out=path.join(root,'.tools/rust-clr-probe'); await mkdir(out,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(child) { if(child.exitCode!==null || child.signalCode!==null)return; child.kill();await new Promise(resolve=>child.once('close',resolve)); }
async function readOnce(exe,args) {
  const child=spawn(exe,args,{windowsHide:true});let data='',errors='';
  const timer=setTimeout(()=>child.kill(),15000);
  child.stdout.on('data',chunk=>{data+=chunk;if(data.length>2*1024*1024)child.kill();});child.stderr.on('data',chunk=>errors+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  return {code,result:JSON.parse(data||'{}'),errors};
}
async function host(mode,fn) {
  const child=spawn(fixturePath,[mode,path.join(out,`${arch}.pid`)],{cwd:path.dirname(fixturePath),windowsHide:true});let errors='',lines=[];
  child.stderr.on('data',c=>errors+=c);child.stdout.on('data',c=>lines.push(...c.toString().trim().split('\n')));
  try {
    await pause(500);assert.equal(child.exitCode,null,errors);
    await fn(child,async command=>{const before=lines.length;child.stdin.write(command+'\n');for(let i=0;i<100 && lines.length===before;i++)await pause(10);assert(lines.slice(before).some(s=>s.trim()===command),`Fixture command not acknowledged: ${command}`);});
  } finally {await stop(child);}
}
const results=[];
for(const mode of ['single','inactive','empty','ambiguous','uninitialized','mismatch']) {
  await host(mode,async child=>{
    const rust=await readOnce(rustPath,[String(child.pid),'--snr']);
    const oracle=await readOnce(csharpPath,[String(child.pid)]);
    assert.equal(rust.result.status,oracle.result.status,`${mode}: ${JSON.stringify({rust,oracle})}`);
    if(rust.result.status==='ok') {
      assert.deepEqual(rust.result.liveLayout,oracle.result.liveLayout,`${mode}: full live layout ${JSON.stringify(rust.result.diagnostics)}`);
      assert.deepEqual(rust.result.players,oracle.result.players,`${mode}: full role metadata`);
    }
    results.push({mode,status:rust.result.status,players:rust.result.players?.length});
  });
}
await host('live',async(child,command)=>{
  const watch=spawn(rustPath,[String(child.pid),'--push-watch',String(process.pid)],{windowsHide:true});let pending='',latest,serial=0,errors='';
  watch.stderr.on('data',c=>errors+=c);
  watch.stdout.on('data',c=>{pending+=c;let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);latest=JSON.parse(line);serial++;}});
  async function expect(ids) {
    const before=serial;for(let i=0;i<100;i++){if(serial>before && latest?.available && JSON.stringify(latest.playerIds)===JSON.stringify(ids))return;await pause(30);}
    assert.fail(`Push watcher expected ${JSON.stringify(ids)}, got ${JSON.stringify(latest)} ${errors}`);
  }
  try {
    await expect([]);await command('push');await expect([3]);
    await command('gc');await expect([3]);
    await command('push-end');await expect([]);
    // The old component/handle remains alive. Completed falls must not replay.
    await command('push');await expect([]);
    await command('replace');await expect([]);await command('push');await expect([3]);
    await command('clear');await expect([]);
    results.push({mode:'live-push',status:'ok',checks:['start','compacting-gc','end','no-replay','array-replacement','clear']});
  } finally {await stop(watch);}
});
await writeFile(path.join(out,`snr-parity-${arch}.json`),JSON.stringify({arch,results},null,2)+'\n');
console.log(JSON.stringify({arch,results}));
