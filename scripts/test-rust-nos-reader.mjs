import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
const root=process.cwd(),x86=process.argv.includes('--x86'),arch=x86?'win-x86':'win-x64';
const configuration=process.argv.includes('--release')?'release':'debug';
const host=path.join(root,`scripts/fixtures/nos-reader/Host/bin/Release/net8.0/${arch}/Among Us.exe`);
const rust=path.join(root,`src-tauri/target/${x86?'i686-pc-windows-msvc/':''}${configuration}/tbcl-clr-reader.exe`);
const oracle=path.join(root,`out/tauri-backend/out/nos-reader/${x86?'x86':'x64'}/TbclSnapshotReader.exe`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill();await new Promise(resolve=>child.once('close',resolve));}
async function read(exe,args){
 const child=spawn(exe,args,{windowsHide:true});let data='',errors='';const timer=setTimeout(()=>child.kill(),15000);
 child.stdout.on('data',c=>{data+=c;if(data.length>2*1024*1024)child.kill();});child.stderr.on('data',c=>errors+=c);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 return {code,result:JSON.parse(data||'{}'),errors};
}
const fixture=spawn(host,[],{cwd:path.dirname(host),windowsHide:true});let lines=[],errors='';
fixture.stdout.on('data',c=>lines.push(...c.toString().trim().split('\n')));fixture.stderr.on('data',c=>errors+=c);
const results=[];
async function compare(command){
 const a=await read(rust,[String(fixture.pid),`--nos-${command}`]);const b=await read(oracle,[command,String(fixture.pid)]);
 assert.equal(a.result.status,'ok',JSON.stringify(a));assert.equal(b.result.status,'ok',JSON.stringify(b));
 assert.deepEqual(a.result.metadata,b.result.metadata,`${command} metadata mismatch`);results.push({command,status:'ok'});
}
try{
 for(let i=0;i<100&&!lines.includes('published');i++)await pause(20);assert(lines.includes('published'),errors);
 await compare('layout');await compare('palette');await compare('roles');
 for(const command of ['color','gc','star-on','star-off','star-unknown','star-clear','lang-guest','lang-current','lang-default','lang-update','lang-large','lang-missing','registry-empty','registry-restore']){
   const before=lines.length;fixture.stdin.write(command+'\n');for(let i=0;i<100&&lines.length===before;i++)await pause(10);
   assert(lines.slice(before).some(s=>s.trim()===command));await compare('roles');
 }
 const out=path.join(root,'.tools/rust-clr-probe');await mkdir(out,{recursive:true});await writeFile(path.join(out,`nos-parity-${arch}.json`),JSON.stringify({arch,results},null,2)+'\n');
 console.log(JSON.stringify({arch,results}));
}finally{await stop(fixture);}
