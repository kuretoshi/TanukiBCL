import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import electron from 'electron';

const directory = resolve('.cache/rokuro-dual');
await mkdir(directory, { recursive: true });
const source = ts.createSourceFile(
	'AudioController.ts',
	await readFile('src/renderer/voice/AudioController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const snippets = [];
function visit(node) {
	if (
		(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
		['applyVoiceAudio', 'setPeerGain', 'rebuildEffectChain', 'createRadioEcho'].includes(node.name?.getText(source))
	)
		snippets.push(node);
	ts.forEachChild(node, visit);
}
visit(source);
assert.equal(snippets.length, 4);
const methods = snippets
	.filter(ts.isMethodDeclaration)
	.map((n) => n.getText(source))
	.join('\n');
const functions = snippets
	.filter(ts.isFunctionDeclaration)
	.map((n) => n.getText(source))
	.join('\n');
const harness = `
import {calculateVoiceAudio} from './src/renderer/voice/spatialAudio';
import {calculateRokuroVoice,createRokuroVoice} from './src/renderer/voice/rokuroVoice';
import {getRokuroVoice} from './src/common/RokuroVoice';
import {GameState} from './src/common/AmongUsState';
import {MapType,CameraLocation} from './src/common/AmongusMap';
import {defaultLobbySettings} from './src/common/defaultLobbySettings';
import {hasTanukiAddon} from './src/common/tanukiAddon';
import {applyVoiceJamming} from './src/common/VoiceJammingState';
import {selectVoiceEffect,shouldApplyRainbowStarEcho} from './src/renderer/voice/voiceEffectRules';
import {getVoiceEffectTuning,combineVoiceEffectTunings} from './src/common/VoiceEffectTuning';
import {createTunedVoiceEffect} from './src/renderer/voice/tunedVoiceEffect';
import {disconnectProcessingEffect} from './src/renderer/voice/sourceFilterEffect';
import {createReverbMix,reverbLevels,connectReverbMix} from './src/renderer/voice/reverbMix';
import {createVoicePeakGuard} from './src/renderer/voice/voicePeakGuard';
import {setEffectGain} from './src/renderer/voice/effectGain';
class Fixture { ${methods} }
${functions}
export {Fixture,calculateVoiceAudio,calculateRokuroVoice,createRokuroVoice,getRokuroVoice,GameState,MapType,CameraLocation,defaultLobbySettings};`;
const bundle = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' },
	bundle: true,
	format: 'iife',
	globalName: 'api',
	write: false,
});
const test = `${bundle.outputFiles[0].text}
(async()=>{
 const checks=[];const ok=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 const state={mod:'NoS',gameState:api.GameState.TASKS,map:api.MapType.UNKNOWN,currentCamera:api.CameraLocation.NONE,closedDoors:[]};
 const me={id:1,clientId:1,x:0,y:0,isLocal:true};
 const other={id:2,clientId:2,x:1,y:0,nosPlayer:{bodyType:3,neckLength:40,speakerPositionX:60,speakerPositionY:0}};
 const settings={enableSpatialAudio:true,voiceEffectTunings:{nosRokurokubi:{pitch:0,reverb:0,echo:0}}};
 const input={state,me,other,settings,activeLobbySettings:api.defaultLobbySettings,maxDistance:5,impostorRadioClientId:-1};
 ok('near body independent of far face',api.calculateVoiceAudio(input).gain===0&&api.calculateRokuroVoice(input).body.gain===1);
 ok('near face independent of far body',api.calculateVoiceAudio({...input,me:{...me,x:59}}).gain===1&&api.calculateRokuroVoice({...input,me:{...me,x:59}}).body.gain===0);
 ok('defaults normalize and clamp',JSON.stringify(api.getRokuroVoice({headVolume:-3,bodyVolume:140,bodyEcho:NaN}))===JSON.stringify({headVolume:0,bodyVolume:100,bodyEcho:50}));
 for(const [name,change] of [
  ['meeting',{state:{...state,gameState:api.GameState.DISCUSSION}}],['dead listener',{me:{...me,isDead:true}}],
  ['dead speaker',{other:{...other,isDead:true}}],['disconnected',{other:{...other,disconnected:true}}],
  ['radio',{impostorRadioClientId:2}],['host disabled',{activeLobbySettings:{...api.defaultLobbySettings,nosRokurokubiVoiceEffect:false}}],
  ['retracted',{other:{...other,nosPlayer:{...other.nosPlayer,neckLength:0}}}],
  ['same origin',{other:{...other,nosPlayer:{...other.nosPlayer,speakerPositionX:1}}}],
  ['invalid origin',{other:{...other,nosPlayer:{...other.nosPlayer,speakerPositionX:NaN}}}],
  ['ordinary mod',{state:{...state,mod:'NONE'}}],
 ])ok(name+' bypass',api.calculateRokuroVoice({...input,...change})===undefined);
 ok('meeting-only policy applies to body',api.calculateRokuroVoice({...input,activeLobbySettings:{...api.defaultLobbySettings,meetingGhostOnly:true}}).body.gain===0);
 ok('jam policy applies to body',api.calculateRokuroVoice({...input,other:{...other,nosPlayer:{...other.nosPlayer,isJammed:true}}}).body.gain===0);
 const doorInput={...input,state:{...state,map:api.MapType.THE_SKELD,closedDoors:[7]},
  me:{...me,x:0,y:-9},other:{...other,x:0,y:-7.5,nosPlayer:{...other.nosPlayer,speakerPositionX:0,speakerPositionY:-9}},
  activeLobbySettings:{...api.defaultLobbySettings,wallsBlockAudio:true}};
 ok('wall test uses body independently from face',api.calculateVoiceAudio(doorInput).gain===1&&api.calculateRokuroVoice(doorInput).body.gain===0);
 ok('opening door restores body voice',api.calculateRokuroVoice({...doorInput,state:{...doorInput.state,closedDoors:[]}}).body.gain===1);
 const rms=(data,a,b)=>Math.sqrt(data.slice(a*48000,b*48000).reduce((s,x)=>s+x*x,0)/((b-a)*48000));
 async function render(echo,atFace=false,muted=false){
  const context=new OfflineAudioContext(2,48000,48000),source=context.createBufferSource();
  source.buffer=context.createBuffer(1,48000,48000);const data=source.buffer.getChannelData(0);
  for(let i=960;i<2880;i++)data[i]=.25*Math.sin(2*Math.PI*500*i/48000);
  const pan=context.createPanner();pan.panningModel='equalpower';pan.distanceModel='linear';pan.refDistance=.1;pan.rolloffFactor=1;
  const gain=context.createGain();gain.gain.value=0;source.connect(pan);pan.connect(gain);gain.connect(context.destination);
  const peer={source,pan,gain,reverbConnected:false,muffleConnected:false,radioEchoConnected:false,voiceEffectConnected:false};
  const fixture=new api.Fixture();Object.assign(fixture,{context,masterGain:context.destination,maxDistance:5,peers:new Map([['peer',peer]])});
  const configured={...settings,rokuroVoice:{headVolume:100,bodyVolume:35,bodyEcho:echo}};
  const apply=()=>fixture.applyVoiceAudio('peer',state,configured,api.defaultLobbySettings,atFace?{...me,x:59}:me,other,-1);
  const amount=apply();fixture.setPeerGain('peer',amount);const retained=peer.rokuroVoice;
  apply();ok('stable graph '+echo+atFace+muted,peer.rokuroVoice===retained);
  ok('body-only returned gain '+echo+atFace+muted,Math.abs(amount-(atFace?1:.35))<1e-8);
  ok('head and body separate gain '+echo+atFace+muted,peer.gain.gain.value===(atFace?1:0));
  source.start();const suspended=context.suspend(.1),rendering=context.startRendering();await suspended;
  if(muted)fixture.setPeerGain('peer',0);await context.resume();
  const rendered=await rendering,left=rendered.getChannelData(0),right=rendered.getChannelData(1);
  let peak=0;for(const channel of [left,right])for(const x of channel){if(!Number.isFinite(x))throw Error('Non-finite audio');peak=Math.max(peak,Math.abs(x));}
  const row={echo,atFace,muted,direct:rms(left,.025,.055)+rms(right,.025,.055),tail:rms(left,.205,.235)+rms(right,.205,.235),peak};
  if(!muted){other.nosPlayer.neckLength=0;apply();ok('retract removes body graph',!peer.rokuroVoice);other.nosPlayer.neckLength=40;}
  return row;
 }
 const rows=[await render(0),await render(100),await render(100,true),await render(100,false,true)];
 ok('body is audible',rows[0].direct>.01);ok('echo zero disables tail',rows[0].tail<.00001);
 ok('body echo adds delayed speech',rows[1].tail>.005);ok('face stays direct',rows[2].direct>.1&&rows[2].tail<.00001);
 ok('mute suppresses queued body echo',rows[3].tail===0);ok('finite bounded mix',rows.every(r=>r.peak<=.9801));
 const loudContext=new OfflineAudioContext(2,48000,48000),oscillator=loudContext.createOscillator(),level=loudContext.createGain();
 oscillator.frequency.value=100;level.gain.value=.95;oscillator.connect(level);
 const both=api.createRokuroVoice(loudContext,level,loudContext.destination);level.connect(both.mix);
 both.configure(1,1,[0,0],5,100);both.setGain(1);oscillator.start();
 const high=await loudContext.startRendering();let combinedPeak=0;
 for(const channel of [0,1])for(const x of high.getChannelData(channel))combinedPeak=Math.max(combinedPeak,Math.abs(x));
 ok('overlapping loud head/body remain below clipping',combinedPeak<=.9801&&combinedPeak>.9);
 return {checks,rows};
})()`;
const server = createServer((_, response) => response.end('<!doctype html>'));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const runner = resolve(directory, 'runner.cjs'),
	result = resolve(directory, 'result.json');
await writeFile(
	runner,
	`const {app,BrowserWindow}=require('electron'),fs=require('fs');app.setPath('userData',${JSON.stringify(resolve(directory, 'profile'))});app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false});await w.loadURL('http://127.0.0.1:${server.address().port}');const result=await w.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(result,null,2));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`
);
const child = spawn(electron, [runner], {
	windowsHide: true,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
let stderr = '';
child.stderr.on('data', (b) => (stderr += b));
const timer = setTimeout(() => child.kill(), 45000);
const exit = await new Promise((done) => child.on('exit', done));
clearTimeout(timer);
server.close();
assert.equal(exit, 0, stderr);
const report = JSON.parse(await readFile(result, 'utf8'));
console.log(`PASS ${report.checks.length} actual Rokuro spatial/controller/OfflineAudio checks`);
console.log(JSON.stringify(report.rows));
