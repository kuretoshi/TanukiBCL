import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
import process from 'node:process';
import console from 'node:console';

const directory = resolve('.cache/nos-berserker-audio');
await mkdir(directory, { recursive: true });
const bundle = await build({
	stdin: {
		contents:
			"export * from './src/renderer/voice/berserkerEffect'; export * from './src/renderer/voice/bibiriEcho'; export { createVoiceEffectPreview } from './src/renderer/settings/voiceEffectPreview';",
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	format: 'iife',
	globalName: 'effects',
	write: false,
	define: { 'import.meta.env.DEV': 'false' },
	plugins: process.env.TANUKI_BERSERKER_BASELINE
		? [
				{
					name: 'berserker-baseline',
					setup(build) {
						build.onLoad({ filter: /berserkerEffect\.ts$/ }, async () => ({
							contents: await readFile(process.env.TANUKI_BERSERKER_BASELINE, 'utf8'),
							loader: 'ts',
						}));
					},
				},
			]
		: [],
});
const impulse = (await readFile('static/sounds/reverb.ogx')).toString('base64');
const test = `${bundle.outputFiles[0].text}
(async()=>{
 const context=new OfflineAudioContext(1,48000*2,48000);
 const source=context.createOscillator();source.frequency.value=500;
 const input=context.createGain();input.gain.value=0.2;source.connect(input);
 const effect=effects.createBerserkerEffect(context);
 input.connect(effect.input);effect.output.connect(context.destination);source.start();source.stop(0.85);
 const clean=context.createOscillator();clean.frequency.value=500;clean.connect(input);clean.start(1.2);
 const suspended=context.suspend(1);
 const rendering=context.startRendering();
 await suspended;
 input.disconnect();effects.disconnectBerserkerEffect(effect);input.connect(context.destination);
 await context.resume();
 const data=(await rendering).getChannelData(0);
 function measure(samples){let rms=0,peak=0,best=0,max=0;for(const x of samples){if(!Number.isFinite(x))throw Error('Non-finite output');rms+=x*x;max=Math.max(max,Math.abs(x));}
 for(let f=450;f<=550;f++){let re=0,im=0;for(let i=0;i<samples.length;i++){const p=2*Math.PI*f*i/48000;re+=samples[i]*Math.cos(p);im+=samples[i]*Math.sin(p);}const power=re*re+im*im;if(power>best){best=power;peak=f;}}
 let re3=0,im3=0;for(let i=0;i<samples.length;i++){const phase=2*Math.PI*1500*i/48000;re3+=samples[i]*Math.cos(phase);im3+=samples[i]*Math.sin(phase);}return {peak,rms:Math.sqrt(rms/samples.length),max,third:Math.hypot(re3,im3)/samples.length};}
 async function pulse(strength,disconnect=false){
  const c=new OfflineAudioContext(1,48000,48000);
  const tone=c.createOscillator(),level=c.createGain();tone.frequency.value=500;level.gain.value=0.2;tone.connect(level);
  const effect=await effects.createVoiceEffectPreview(c,'nosBerserker',{pitch:0,reverb:0,echo:strength});
  level.connect(effect.input);effect.output.connect(c.destination);tone.start();tone.stop(0.035);
  const suspended=disconnect?c.suspend(0.32):null;
  const rendering=c.startRendering();
  if(suspended){await suspended;effect.dispose();await c.resume();}
  const samples=(await rendering).getChannelData(0);
  const rms=(from,to)=>{const window=samples.slice(Math.floor(from*48000),Math.floor(to*48000));return Math.sqrt(window.reduce((sum,value)=>sum+value*value,0)/window.length);};
  return {direct:rms(0.01,0.025),gap:rms(0.29,0.32),second:rms(0.35,0.405),third:rms(0.53,0.585)};
 }
 globalThis.fetch=async()=>({arrayBuffer:async()=>Uint8Array.from(atob('${impulse}'),character=>character.charCodeAt(0)).buffer});
 async function star(strength,dispose=false){
  const c=new OfflineAudioContext(1,48000,48000);
  const tone=c.createOscillator(),level=c.createGain();tone.frequency.value=500;level.gain.value=0.2;tone.connect(level);
  const preview=await effects.createVoiceEffectPreview(c,'nosRainbowStar',{pitch:0,reverb:strength,echo:0});
  level.connect(preview.input);preview.output.connect(c.destination);tone.start();tone.stop(0.035);
  const paused=dispose?c.suspend(0.1):null,rendering=c.startRendering();
  if(paused){await paused;preview.dispose();await c.resume();}
  return (await rendering).getChannelData(0);
 }
 const starDry=await star(0),starHalf=await star(50),starWet=await star(100),starStopped=await star(100,true);
 async function bibiri(echoAmount,realImpulse=false,neutral=false){
  const c=new OfflineAudioContext(1,48000*4,48000),tone=c.createOscillator(),level=c.createGain();
  tone.frequency.value=500;level.gain.value=0.2;tone.connect(level);
  const ir=realImpulse?await c.decodeAudioData(await (await fetch('fixture')).arrayBuffer()):c.createBuffer(1,1,48000);
  if(!realImpulse)ir.getChannelData(0)[0]=1;
  const tuning=neutral?{pitch:0,reverb:0,echo:0}:{pitch:0,reverb:100,echo:echoAmount};
  const effect=effects.createBibiriEcho(c,level,c.destination);
  effects.updateBibiriEcho(effect,true,false,undefined,100000,tuning,ir);
  tone.start();tone.stop(0.035);
  const paused=c.suspend(0.4),rendering=c.startRendering();
  await paused;effects.updateBibiriEcho(effect,true,true,100000,100400,tuning,ir);await c.resume();
  const data=(await rendering).getChannelData(0);
  const rms=(from,to)=>{const samples=data.slice(Math.floor(from*48000),Math.floor(to*48000));return Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);};
  effects.disconnectBibiriEcho(effect);
  return {first:rms(.605,.625),second:rms(.905,.925),beforeEnd:rms(2.7,2.79),afterEnd:rms(2.8,3.5)};
 }
 const bibiriOne=await bibiri(0),bibiriRepeat=await bibiri(100),bibiriRoom=await bibiri(100,true),bibiriNeutral=await bibiri(0,false,true);
 const tailRms=samples=>Math.sqrt(samples.slice(14400,28800).reduce((sum,value)=>sum+value*value,0)/14400);
 let mixError=0;for(let i=0;i<starHalf.length;i++)mixError=Math.max(mixError,Math.abs(starHalf[i]-(starDry[i]+starWet[i])/2));
 return {active:measure(data.slice(14400,33600)),tail:measure(data.slice(43200,47000)),released:measure(data.slice(67200,86400)),
  pulse:await pulse(100),zero:await pulse(0),disconnected:await pulse(100,true),
  star:{dryTail:tailRms(starDry),wetTail:tailRms(starWet),stoppedTail:tailRms(starStopped),mixError},
  bibiri:{one:bibiriOne,repeat:bibiriRepeat,room:bibiriRoom,neutral:bibiriNeutral}};
})() ;`;
await writeFile(
	resolve(directory, 'test.cjs'),
	`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});await win.loadURL('about:blank');const result=await win.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(resolve(directory, 'result.json'))},JSON.stringify(result,null,2));app.quit();}catch(error){console.error(error);app.exit(1);}});`
);
const result = spawnSync(electron, [resolve(directory, 'test.cjs')], {
	windowsHide: true,
	encoding: 'utf8',
	timeout: 30000,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
assert.equal(result.status, 0, result.stderr);
const audio = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
assert.ok(Math.abs(audio.active.peak - 500) <= 2, 'berserking preserves source pitch while adding distortion');
assert.ok(Math.abs(audio.released.peak - 500) <= 2, 'disconnecting effect restores the original pitch');
assert.ok(audio.active.rms > 0.05 && audio.active.max < 1, 'audible, finite, unclipped effect output');
assert.ok(Math.abs(audio.released.rms - Math.SQRT1_2 * 0.2) < 0.005, 'original gain is restored');
assert.ok(
	audio.active.third > 0.0005 && audio.released.third < 0.00001,
	'distortion adds harmonics only during berserking'
);
assert.ok(audio.tail.rms < 0.0000001, 'the grit profile has no private IR or duplicate tail');
assert.ok(
	audio.pulse.second > 0.0001 && audio.pulse.second > audio.pulse.gap * 10,
	'a distinct repeat remains at 360ms, after the original short room tail has ended'
);
assert.ok(
	audio.pulse.third > 0.00001 && audio.pulse.third < audio.pulse.second,
	'echo feedback decays rather than sustaining speech'
);
assert.ok(Math.abs(audio.zero.direct - Math.SQRT1_2 * 0.2) < 0.005, 'strength zero preserves clean speech gain');
assert.ok(audio.zero.second < 0.0000001 && audio.zero.third < 0.0000001, 'strength zero has no echo');
assert.ok(audio.disconnected.second < 0.0000001, 'disconnect stops pending repeats');
assert.ok(
	audio.star.wetTail > 0.00001,
	'Star preview uses the shipped room impulse with an audible 300-600ms reverb tail'
);
assert.equal(audio.star.dryTail, 0, 'Star strength zero has no reverb tail');
assert.equal(audio.star.stoppedTail, 0, 'disposing Star preview stops the tail');
assert.ok(audio.star.mixError < 0.000001, 'Star 50% is the same dry/wet mix as the live convolver graph');
assert.ok(audio.bibiri.one.first > 0.00001, 'Bibiri echo0 with reverb still plays its retained fragment once');
assert.equal(audio.bibiri.one.second, 0, 'Bibiri echo0 does not repeat the fragment');
assert.ok(
	audio.bibiri.repeat.second > audio.bibiri.repeat.first * 0.1,
	'Bibiri echo100 retains repeated event playback'
);
assert.ok(audio.bibiri.room.beforeEnd > 0, 'real-IR fixture has a live tail before the event gate closes');
assert.equal(
	audio.bibiri.room.afterEnd,
	0,
	'the final event envelope stops a real IR tail at 2.4s without another state update'
);
assert.deepEqual(
	audio.bibiri.neutral,
	{ first: 0, second: 0, beforeEnd: 0, afterEnd: 0 },
	'all-zero Bibiri does not retain or replay speech'
);
console.log('PASS actual Web Audio Berserker echo, Star reverb, strength and lifecycle:', JSON.stringify(audio));
