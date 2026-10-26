import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-distributed-speech-'));
async function load(entry, name, mocked = false) {
 const result = await build({entryPoints:[entry], bundle:true, platform:'node', format:'esm', write:false,
  define:{'import.meta.env.DEV':'false'}, plugins:mocked ? [{name:'mock-ipc',setup(b){
   b.onResolve({filter:/electron-bridge$/},()=>({path:'ipc',namespace:'mock'}));
   b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const ipcRenderer = globalThis.speechTestIpc;'}));
  }}] : []});
 const path=join(directory,name+'.mjs'); await writeFile(path,result.outputFiles[0].contents); return import(pathToFileURL(path));
}
const originalInterval=globalThis.setInterval, originalClear=globalThis.clearInterval, originalNow=Date.now;
try {
 const common=await load('src/common/HeroSpeech.ts','policy');
 for(const host of [false,true]) for(const platform of [undefined,'desktop','web','mobile']) {
  assert.equal(common.shouldRecogniseSpeech(true,host,platform),true);
  assert.equal(common.shouldRecogniseSpeech(false,host,platform),host && ['web','mobile'].includes(platform));
 }
 assert(common.heardForbiddenWord('イン ポスターだと思います',['いんぽすたー'],true));
 assert(!common.heardForbiddenWord('インポスター',['インポスター'],false),'partial text cannot kill');
 assert(!common.heardForbiddenWord('クルーメイト',['インポスター'],true));
 assert(common.heardForbiddenWord('ＴＡＳＫ',['task'],true));
 assert(common.heardTransformation('蒸着',['蒸着','じょうちゃく'],true));
 assert(common.heardTransformation('ジョウ チャク',['蒸着','じょうちゃく'],false));
 assert(!common.heardTransformation('変身',['蒸着','じょうちゃく'],true),'custom word disables default keyword');
 assert(!common.heardTransformation('返信',['蒸着'],true),'default homophone correction does not leak into custom words');
 assert(common.heardTransformation('へんしん',['変身'],false),'default kana remains compatible');
 assert(common.heardTransformation('返信',['変身'],true));
 assert(!common.heardTransformation('返信',['変身'],false));
 assert(common.heardTransformation('変身',[],true),'old addon jobs remain supported');
 const {validHeroSpeechDescriptor}=await load('src/main/heroSpeechBridge.ts','bridge');
 const job=(playerId,kind='hero',request=1)=>({playerId,kind,request,expires:11000,words:kind==='ng'?['タスク','たすく']:[]});
 const envelope={protocol:2,pid:99,port:12345,token:'a'.repeat(32),updated:10000,players:[job(1),job(1,'ng')]};
 assert(validHeroSpeechDescriptor(envelope,99,10000),'hero and NG may coexist on one player');
 assert(!validHeroSpeechDescriptor({...envelope,protocol:1},99,10000),'old protocol rejected');
 assert(!validHeroSpeechDescriptor({...envelope,players:[job(1),job(1)]},99,10000),'duplicate jobs rejected');
 assert(!validHeroSpeechDescriptor(envelope,98,10000),'other game PID rejected');
 assert(!validHeroSpeechDescriptor(envelope,99,12000),'stale descriptor rejected');
 const sent=[], recognizers=[];
 let snapshot;
 globalThis.speechTestIpc={invoke:async()=>snapshot, send:(...args)=>sent.push(args)};
 globalThis.setInterval=()=>0; globalThis.clearInterval=()=>{};
 let now=10000; Date.now=()=>now;
 const fakeModel={terminate(){},KaldiRecognizer:class {
  events={}; removed=false;
  constructor(){recognizers.push(this)} on(name,handler){this.events[name]=handler} remove(){this.removed=true} acceptWaveform(){}
 }};
 globalThis.window={Vosk:{createModel:async()=>fakeModel}};
 globalThis.document={createElement:()=>({}),head:{appendChild:element=>element.onload()}};
 const {HeroSpeech}=await load('src/renderer/voice/heroSpeech.ts','renderer',true);
 const {GameState}=await load('src/common/AmongUsState.ts','states');
 const audio=()=>({connect(){},disconnect(){}});
 const context={sampleRate:48000,createScriptProcessor:()=>audio(),createGain:()=>({...audio(),gain:{value:1}}),destination:audio()};
 const speech=new HeroSpeech(context);
 const state={mod:'NoS',isHost:true,lobbyCode:'ROOM01',gameState:GameState.TASKS,players:[{id:1,isLocal:true}]};
 speech.setContext(state);
 let localAllowed=true;
 for(const [key,id] of [['local',1],['pc',2],['web',3],['mobile',4],['unknown',5]]) speech.setInput(key,audio(),id,()=>key!=='local'||localAllowed);
 speech.setPeerPlatform('pc','desktop'); speech.setPeerPlatform('web','web'); speech.setPeerPlatform('mobile','mobile');
 snapshot={pid:99,session:'a'.repeat(32),players:[job(1),job(1,'ng'),job(2),job(3),job(4),job(5)]};
 await speech.poll(); await speech.poll();
 assert.deepEqual([...speech.captures.keys()].sort(),[1,3,4],'host excludes PC/unknown audio');
 assert.equal(recognizers.length,3,'hero and NG share one recognizer per speaker');
 const local=speech.captures.get(1).recognizer;
 local.events.result({result:{text:'タスク'}}); local.events.result({result:{text:'タスク'}});
 assert.equal(sent.filter(a=>a[0]==='NOS_HERO_SPEECH_WORD' && a[4]==='ng').length,1,'death report deduplicated');
 local.events.result({result:{text:'変身'}});
 assert.equal(sent.filter(a=>a[0]==='NOS_HERO_SPEECH_WORD' && a[4]==='hero').length,1,'hero still works alongside NG');
 snapshot={...snapshot,players:[{...job(1,'hero',9),words:['蒸着','じょうちゃく']},job(1,'ng'),{...job(3,'hero',9),words:['闇落ち','やみおち']}]};
 await speech.poll();
 const customLocal=speech.captures.get(1).recognizer, customWeb=speech.captures.get(3).recognizer;
 const heroReports=()=>sent.filter(a=>a[0]==='NOS_HERO_SPEECH_WORD' && a[4]==='hero').length;
 const beforeCustom=heroReports();
 customLocal.events.result({result:{text:'変身'}}); customWeb.events.result({result:{text:'蒸着'}});
 assert.equal(heroReports(),beforeCustom,'old keyword and another hero keyword cannot activate custom jobs');
 customLocal.events.result({result:{text:'じょうちゃく'}}); customWeb.events.result({result:{text:'闇落ち'}});
 assert.equal(heroReports(),beforeCustom+2,'local PC and host-recognised Web jobs use their own configured word');
 speech.setContext({...state,isHost:false}); await speech.poll();
 assert.equal(speech.captures.size,0,'nonhost cannot keep remote captures');
 snapshot={...snapshot,players:[job(1,'hero',2),job(3)]}; await speech.poll();
 assert.deepEqual([...speech.captures.keys()],[1],'nonhost recognises own microphone');
 const beforeMute=speech.captures.get(1); localAllowed=false;
 beforeMute.processor.onaudioprocess({}); assert(!speech.captures.has(1),'mute discards buffered recognition');
 await speech.poll(); assert(!speech.captures.has(1),'muted local input does not create recognizers');
 localAllowed=true; await speech.poll(); assert.notEqual(speech.captures.get(1),beforeMute,'unmute starts a fresh recognizer');
 speech.setContext({...state,isHost:true}); await speech.poll();
 assert(speech.captures.has(3)); now+=7000; snapshot.players.forEach(p=>p.expires=now+1000); await speech.poll();
 assert(!speech.captures.has(3),'expired platform declaration removes remote recognition');
 speech.setContext({...state,gameState:GameState.MENU});
 assert.equal(speech.captures.size,0,'leaving game clears recognition');
 speech.dispose();
 console.log('PASS distributed speech: routing, shared recognizers, replay suppression, protocol and lifecycle');
} finally {
 globalThis.setInterval=originalInterval; globalThis.clearInterval=originalClear; Date.now=originalNow;
 await rm(directory,{recursive:true,force:true});
}
