import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/nos-berserker-audio');
await mkdir(directory, { recursive: true });
const bundle = await build({
	entryPoints: ['src/renderer/voice/berserkerEffect.ts'],
	bundle: true,
	format: 'iife',
	globalName: 'effects',
	write: false,
});
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
 return {active:measure(data.slice(14400,33600)),tail:measure(data.slice(43200,47000)),released:measure(data.slice(67200,86400))};
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
assert.ok(
	audio.tail.rms > 0.00001 && audio.tail.rms < audio.active.rms,
	'short reverb tail remains after speech stops'
);
console.log('PASS actual Web Audio distortion, short reverb and release:', JSON.stringify(audio));
