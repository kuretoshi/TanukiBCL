import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSocket} from 'node:dgram';
import {setTimeout as delay} from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'tanuki-host-test-'));
const socket=createSocket('udp4');
const old=process.env.LOCALAPPDATA;
try {
 let index=0;
 async function bundle(entry){const output=join(dir,`${index++}.mjs`);const result=await build({entryPoints:[resolve(entry)],bundle:true,platform:'node',format:'esm',write:false});await writeFile(output,result.outputFiles[0].contents);return import(pathToFileURL(output));}
 process.env.LOCALAPPDATA=dir;
 const {HostVoiceAdmission}=await bundle('src/renderer/HostVoiceAdmission.ts');
 const {HostVoiceClient}=await bundle(process.env.TANUKI_MOBILE_SOURCE || '../BetterCrewlink-mobile/src/app/services/host-voice-client.ts');
 const {sendHostVoice}=await bundle('src/main/nosHostVoiceRelay.ts');
 await new Promise(r=>socket.bind(0,'127.0.0.1',r));
 await mkdir(join(dir,'TanukiBCL','NoS'),{recursive:true});
 await writeFile(join(dir,'TanukiBCL','NoS','host-voice-123.json'),JSON.stringify({protocol:1,pid:123,port:socket.address().port,token:'a'.repeat(32)}));
 const packets=[];socket.on('message',bytes=>packets.push(bytes.toString().split('|')));
 const player={id:7,clientId:42,disconnected:false,isDead:false};
 const state={mod:'NoS',gameState:1,isHost:true,lobbyCode:'ABCDEF',players:[player]};
 const client={playerId:7,clientId:42}; const admission=new HostVoiceAdmission();let last;
 const mobile=new HostVoiceClient(data=>{last=data;assert(admission.accept('mobile',client,data,state));assert(sendHostVoice(data.playerId,data.rms,data.active,123,state));},()=>{});
 mobile.sample(.5,true,state,player,true,10000,10000);
 await delay(80); assert.equal(packets.length,1);assert.equal(packets[0][2],'7');assert.equal(packets[0][5],'0.5');
 assert(!admission.accept('mobile',client,last,state));
 assert(!admission.accept('other',{playerId:8,clientId:88},last,state));
 assert(!sendHostVoice(7,.5,true,123,{...state,isHost:false}));
 assert.doesNotThrow(()=>assert.equal(sendHostVoice(7,.5,true,123,{...state,players:undefined}),false),
  'host relay must ignore a missing player list during Among Us shutdown');
 mobile.sample(.5,false,state,player,true,10100,10100);await delay(80);assert.equal(packets[1][6],'0');
 console.log('PASS Web/mobile -> authenticated host admission -> actual loopback UDP; replay, impersonation, non-host, mute');
} finally {socket.close();if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old;await rm(dir,{recursive:true,force:true});}
