// Final matched benchmark: real private multiplayer game, one loopback voice
// peer, default hardware devices, AEC/NS/AGC on, zero speaker volume. Run only
// after packaging. Counts every descendant, excluding game/fixture processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { startFixture } from './native-voice/fixture-server.mjs';
import { createServer } from 'node:http';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key)+1] : fallback;
const gamePid = Number(opt('--game-pid', 0));
const expectedPlayers=Number(opt('--players','4'));
assert.ok(Number.isInteger(expectedPlayers)&&expectedPlayers>=4&&expectedPlayers<=15);
assert.ok(Number.isSafeInteger(gamePid) && gamePid > 0, 'Supply the owned private game PID');
const {version} = JSON.parse(await readFile(join(root,'src-tauri/tauri.conf.json')));
const native = join(root,`dist-tauri/TanukiBCL-Tauri-Beta-${version}/TanukiBCL-Tauri-Beta.exe`);
const electron = join(root,'.tools/memory-comparison/electron/TanukiBCL.exe');
const net = join(root,'.tools/memory-comparison/net/TanukiBCL.Net.exe');
const directory = join(root,'.tools/memory-final',`run-${Date.now()}`);
await mkdir(directory,{recursive:true});
const netSettings = join(process.env.APPDATA,'TanukiBCL.Net/settings.json');
const tauriSettings = join(process.env.APPDATA,'work.kuretoshi.tanukibcl.tauri.beta/config.json');
const originals = await Promise.all([netSettings,tauriSettings].map(async path=>({path,bytes:await readFile(path),info:await stat(path)})));
await writeFile(join(directory,'private-net-settings-backup.json'),originals[0].bytes);
const sha = b=>createHash('sha256').update(b).digest('hex');
const json = async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const owned = new Set();
function launch(exe, parameters, name, extraEnv={}) {
  const env={...process.env,...extraEnv};
  for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','TANUKI_RUST_TRACE']) delete env[key];
  const p=spawn(exe,parameters,{cwd:dirname(exe),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  owned.add(p); let log='';
  for(const stream of [p.stdout,p.stderr]) stream.on('data',b=>log=(log+b).slice(-120000));
  p.finished=new Promise((done,fail)=>{
    p.once('error',fail);
    p.once('exit',async code=>{owned.delete(p); await writeFile(join(directory,`${name}.log`),log);code===0?done():fail(new Error(`${name} exit ${code}: ${log.slice(-3000)}`));});
  });
  p.finished.catch(()=>{}); return p;
}
const median = a=>{a=a.toSorted((x,y)=>x-y);return (a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2;};
const duration=100, stableStart=60, stableEnd=90;
const rules={maxDistance:5.32,haunting:false,commsSabotage:false,voiceEffectEnabled:false,deadOnly:false,wallsBlockAudio:false,hearThroughCameras:false,visionHearing:false,meetingGhostOnly:false,impostorRadioEnabled:false,impostorRadioOnlyMode:false,publicLobby_on:false};
const probe=async suffix=>{
  const path=join(directory,`private-game-${suffix}.json`);
  await launch(native,['--rust-reader-probe',String(gamePid),'--probe-samples','1','--probe-output',path],`reader-${suffix}`).finished;
  const game=(await json(path)).states[0];
  assert.equal(game.mod,'NONE');assert.equal(game.gameState,1);assert.equal(game.isHost,true);assert.equal(game.players.length,expectedPlayers);
  return game;
};
const results=[];
// Keep the live Rust access check local as well as voice signaling. This
// override is accepted by the app only with a validated loopback voice lab.
const access=createServer((request,response)=>{let bytes=0;request.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)request.destroy();});request.on('end',()=>{response.writeHead(200,{'Content-Type':'application/json'});response.end('{"banned":false}');});});
await new Promise(resolve=>access.listen(0,'127.0.0.1',resolve));
const accessUrl=`http://127.0.0.1:${access.address().port}/v1/player-bans/check`;
try {
  const game=await probe('before');
  const local=game.players.find(p=>p.isLocal);
  const remote=game.players.filter(p=>!p.isLocal&&!p.isDead&&!p.disconnected).toSorted((a,b)=>Math.hypot(a.x-local.x,a.y-local.y)-Math.hypot(b.x-local.x,b.y-local.y))[0];
  assert.ok(remote,'A second live player is required');
  const remoteDistance=Math.hypot(remote.x-local.x,remote.y-local.y);
  assert.ok(remoteDistance<5.32,'Keep another player within hearing range before comparing active proximity audio');
  const modes=opt('--modes','electron,tauri-ui,net,tauri-background,tauri-background,net,tauri-ui,electron').split(',');
  for(const[index,mode]of modes.entries()){
    assert.ok(['electron','net','tauri-ui','tauri-background'].includes(mode));
    const label=`final-${Date.now()}-${mode}-${index+1}`;
    const server=await startFixture({room:game.lobbyCode,hostClientId:game.hostId});
    try{
      const remoteGame=structuredClone(game);remoteGame.clientId=remote.clientId;remoteGame.isHost=false;
      for(const p of remoteGame.players)p.isLocal=p.clientId===remote.clientId;
      const peerConfig=join(directory,`${label}-private-peer.json`),peerOutput=join(directory,`${label}-peer.json`);
      await writeFile(peerConfig,JSON.stringify({serverUrl:server.url,game:remoteGame,frequency:660,lobbySettings:rules}));
      const peer=launch(native,['--native-voice-probe','--voice-test-config',peerConfig,'--voice-test-output',peerOutput,'--voice-test-seconds',String(duration+12)],`${label}-peer`);
      let exe,parameters=[],backend='auto',labOutput;
      if(mode.startsWith('tauri')){
        exe=native;backend='rust';const config=join(directory,`${label}-lab.json`);labOutput=join(directory,`${label}-lab-result.json`);
        await writeFile(config,JSON.stringify({serverUrl:server.url,output:labOutput,durationSeconds:duration,audioProcessing:true,closeAfterSeconds:mode==='tauri-background'?15:null}));
        parameters=['--native-voice','--backend=rust','--voice-lab-config',config];
      }else if(mode==='electron'){
        exe=electron;const profile=join(directory,'electron-profile');await mkdir(profile,{recursive:true});
        await writeFile(join(profile,'config.json'),JSON.stringify({__internal__:{migrations:{version:'3.2.62'}},serverURL:server.url,serverURLs:[server.url],language:'ja',microphone:'Default',speaker:'Default',echoCancellation:true,noiseSuppression:true,autoGainControl:true,enableSpatialAudio:true,microphoneGainEnabled:false,micSensitivityEnabled:false,pushToTalkMode:0,masterVolume:0,enableOverlay:false,obsOverlay:false,mobileHost:false,natFix:false,playerConfigMap:{},myLobbySettings:rules}));
        parameters=[`--user-data-dir=${profile}`];
      }else{
        exe=net;
        const settings=JSON.parse(originals[0].bytes.toString('utf8').replace(/^\uFEFF/,''));
        Object.assign(settings,{ServerUrl:server.url,ServerUrls:[server.url],MicrophoneName:null,MicrophoneDeviceId:null,SpeakerName:null,EchoCancellation:true,NoiseSuppression:true,AutoGainControl:true,EnableSpatialAudio:true,MicrophoneGainEnabled:false,MicSensitivityEnabled:false,PushToTalkMode:0,MasterVolume:0,EnableOverlay:false,ObsOverlay:false,MobileHost:false,NatFix:false,PlayerConfigMap:{},MyLobbySettings:Object.fromEntries(Object.entries(rules).map(([k,v])=>[k[0].toUpperCase()+k.slice(1),v]))});
        await writeFile(netSettings,JSON.stringify(settings,null,2));parameters=['--game-process-id',String(gamePid)];
      }
      const measure=launch('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/measure-tauri-memory.ps1'),'-Label',label,'-Executable',exe,'-DurationSeconds',String(duration+5),'-GameProcessId',String(gamePid),'-Backend',backend,...parameters],`${label}-measure`,{TANUKI_TAURI_DATA:join(directory,'native-reader-cache'),...(mode.startsWith('tauri')?{TANUKI_BAN_CHECK_URL:accessUrl}:{})});
      console.log(JSON.stringify({event:'started',mode,index:index+1,label,directory,seconds:duration}));
      await measure.finished;await peer.finished;
      const peerReport=await json(peerOutput);
      const stablePeer=peerReport.progress.filter(p=>p.second>=stableStart&&p.second<=stableEnd);
      assert.ok(stablePeer.length>=25,'Missing peer observations');
      const first=stablePeer[0].metrics,last=stablePeer.at(-1).metrics;
      assert.ok(last.sentPackets>first.sentPackets+100,'Peer transmission stopped');
      assert.ok(last.receivedPackets>first.receivedPackets+20,'Measured application microphone transmission stopped');
      assert.ok(last.decodedFrames>first.decodedFrames+48000,'Measured microphone was not decoded');
      if(labOutput){
        const lab=await json(labOutput),stable=lab.progress.filter(p=>p.second>=stableStart&&p.second<=stableEnd);
        for(const p of stable){assert.equal(p.game.gameState,1);assert.equal(p.game.players,expectedPlayers);assert.equal(p.voice.engine,'native');assert.equal(p.voice.connected,true);assert.equal(p.voice.audioReady,true);assert.equal(p.voice.peers,1);assert.equal(p.voice.hasError,false);assert.equal(p.openWebviews,mode==='tauri-ui'?1:0);}
        const a=stable[0].voice.metrics,b=stable.at(-1).voice.metrics;
        for(const k of ['capturedFrames','renderedFrames','decodedFrames','processedFrames'])assert.ok(b[k]>a[k]+48000,k);
        assert.equal(b.droppedFrames,a.droppedFrames);
      }
      const samples=(await readFile(join(root,'.tools/memory-comparison',`${label}.samples.jsonl`),'utf8')).replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse).filter(s=>s.elapsedSeconds>=stableStart&&s.elapsedSeconds<=stableEnd);
      assert.ok(samples.length>=10);assert.ok(samples.every(s=>s.failedCount===0&&s.processes.length>0));
      if(mode==='tauri-background')assert.ok(samples.every(s=>s.processes.length===1&&s.processes[0].kind==='host'));
      const diagnostics=await readFile(join(root,'.tools/memory-comparison',`${label}.stderr.log`),'utf8');
      const playbackWarnings=(diagnostics.match(/discard a playback frame|Auto-filling the buffer/g)||[]).length;
      const microphoneDecodedSeconds=(last.decodedFrames-first.decodedFrames)/48000;
      const result={mode,label,samples:samples.length,privateWorkingSetMiB:median(samples.map(s=>s.privateWorkingSetBytes/1048576)),privateCommitMiB:median(samples.map(s=>s.privateBytes/1048576)),totalWorkingSetMiB:median(samples.map(s=>s.workingSetBytes/1048576)),processCounts:[...new Set(samples.map(s=>s.processes.length))],voicePacketsReceived:last.receivedPackets-first.receivedPackets,voicePacketsSent:last.sentPackets-first.sentPackets,microphoneDecodedSeconds,playbackWarnings,referenceOnly:playbackWarnings>0||microphoneDecodedSeconds<24};
      results.push(result);await writeFile(join(directory,'partial.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({event:'measured',...result}));
      await probe(String(index+1));
    }finally{await server.close();}
  }
  const summaries=[...new Set(results.map(r=>r.mode))].map(mode=>{const runs=results.filter(r=>r.mode===mode);return {mode,runs:runs.length,referenceOnly:runs.some(r=>r.referenceOnly),privateWorkingSetMiB:median(runs.map(r=>r.privateWorkingSetMiB)),privateCommitMiB:median(runs.map(r=>r.privateCommitMiB)),totalWorkingSetMiB:median(runs.map(r=>r.totalWorkingSetMiB))};});
  const report={passed:true,date:new Date().toISOString(),versions:{tauri:version,electron:'3.2.62',net:'3.2.62-net-beta.1'},executableSha256:Object.fromEntries(await Promise.all([['tauri',native],['electron',electron],['net',net]].map(async([k,p])=>[k,sha(await readFile(p))]))),conditions:{game:'Vanilla v19s (7489)',map:game.map,phase:'TASKS',players:expectedPlayers,voicePeers:1,remoteDistance,maxDistance:5.32,remoteInHearingRange:remoteDistance<5.32,hardwareAudio:true,syntheticRemote:true,audioSaved:false,volume:0,aec:true,ns:true,agc:true,overlay:false,durationSeconds:duration,stableSeconds:[stableStart,stableEnd],processTree:true,units:'MiB (1024^2 bytes)',statistic:'median of per-run steady-state medians'},summaries,results};
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));
  await writeFile(join(root,'docs/memory-comparison-rust-ui-3.2.62.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({event:'completed',summaries,directory}));
}finally{
  for(const p of owned)p.kill();
  await new Promise(resolve=>access.close(resolve));
  for(const original of originals){
    if(original.path===netSettings)await writeFile(original.path,original.bytes);
    assert.equal(sha(await readFile(original.path)),sha(original.bytes),'User settings changed');
    await utimes(original.path,original.info.atime,original.info.mtime);
  }
  await writeFile(join(directory,'settings-restoration.json'),JSON.stringify({byteForByte:true,timestampsRestored:true}));
}
