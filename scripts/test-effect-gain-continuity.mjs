import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import electron from 'electron';

const directory = resolve(process.env.EFFECT_CONTINUITY_CACHE ?? '.cache/effect-gain-continuity');
await mkdir(directory, { recursive: true });
const bundled = await build({
	stdin: {
		contents:
			"export * from './src/renderer/voice/tunedVoiceEffect'; export { prepareSourceFilter } from './src/renderer/voice/sourceFilterEffect';",
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	format: 'iife',
	globalName: 'effects',
	write: false,
});
const test = `${bundled.outputFiles[0].text}
(async()=>{
 const rows=[];
 for(const kind of ['echo','reverb','grit','bibiri']){
  const rate=48000,context=new OfflineAudioContext(1,rate,rate);
  // A delayed impulse makes the dry/wet change reproducible without fetching an asset.
  const impulse=context.createBuffer(1,241,rate);impulse.getChannelData(0)[240]=1;
  const playback=effects.createTunedPlayback(context,kind==='bibiri');
  const tuning=amount=>({pitch:0,reverb:kind==='reverb'?amount:0,echo:kind==='echo'||kind==='bibiri'?amount:0});
  playback.update(tuning(25),impulse,true,kind==='grit'?25:0);
  const oscillator=context.createOscillator(),level=context.createGain();
  oscillator.type='sine';oscillator.frequency.value=100;level.gain.value=.2;
  oscillator.connect(level);level.connect(playback.input);playback.output.connect(context.destination);oscillator.start();
  const paused=context.suspend(.5),rendering=context.startRendering();
  await paused;const change=context.currentTime;
  playback.update(tuning(75),impulse,true,kind==='grit'?75:0);
  // The same snapshot must not restart a ramp every time game state is received.
  playback.update(tuning(75),impulse,true,kind==='grit'?75:0);
  await context.resume();const data=(await rendering).getChannelData(0);
  const boundary=Math.round(change*rate),naturalBound=.2*2*Math.PI*100/rate;
  const jump=Math.abs(data[boundary]-data[boundary-1]);
  let maxStep=0,peak=0;for(let i=1;i<data.length;i++){
   if(!Number.isFinite(data[i]))throw Error(kind+' non-finite audio');peak=Math.max(peak,Math.abs(data[i]));
   if(i>=boundary-128&&i<boundary+1600)maxStep=Math.max(maxStep,Math.abs(data[i]-data[i-1]));
  }
  rows.push({kind,change,jump,maxStep,naturalBound,peak});playback.disconnect();
 }
 const rate=48000,context=new OfflineAudioContext(1,rate,rate);
 await effects.prepareSourceFilter(context);
 const playback=effects.createTunedPlayback(context),source=context.createBufferSource(),buffer=context.createBuffer(1,rate,rate);
 const input=buffer.getChannelData(0),harmonics=[];
 for(let f=120;f<6000;f+=120)harmonics.push([f,.03+Math.exp(-(((f-700)/200)**2))+.8*Math.exp(-(((f-1800)/300)**2))]);
 let peak=0;for(let i=0;i<rate;i++){let v=0;for(const [f,a] of harmonics)v+=a*Math.sin(2*Math.PI*f*i/rate);input[i]=v;peak=Math.max(peak,Math.abs(v));}
 for(let i=0;i<rate;i++)input[i]*=.25/peak;
 source.buffer=buffer;source.connect(playback.input);playback.output.connect(context.destination);source.start();
 const paused=context.suspend(.4),rendering=context.startRendering();await paused;const change=context.currentTime;
 playback.update({pitch:50,reverb:0,echo:0},null);await context.resume();const data=(await rendering).getChannelData(0);
 const rms=(samples,from,to)=>Math.sqrt(samples.slice(from,to).reduce((sum,x)=>sum+x*x,0)/(to-from));
 const boundary=Math.round(change*rate),window=960;
 const onset={change,rawRms:rms(input,boundary,boundary+window),warmupRms:rms(data,boundary,boundary+window),steadyRms:rms(data,rate*.7,rate*.8)};
 playback.disconnect();return {rows,onset};
})()`;
const resultPath = resolve(directory, 'result.json');
const runner = resolve(directory, 'runner.cjs');
const server = createServer((_, response) => response.end('<!doctype html>'));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(
	runner,
	`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setName('Tanuki-effect-continuity');app.setPath('userData',${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});await win.loadURL(${JSON.stringify(origin)});
const rows=await win.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(rows,null,2));app.quit();
}catch(error){console.error(error);app.exit(1);}});`
);
const child = spawn(electron, [runner], {
	windowsHide: true,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
const timeout = setTimeout(() => child.kill(), 30000);
const status = await new Promise((done) => child.on('exit', done));
clearTimeout(timeout);
server.close();
assert.equal(status, 0, stderr);
const { rows, onset } = JSON.parse(await readFile(resultPath, 'utf8'));
console.log(JSON.stringify({ rows, onset }, null, 2));
if (!process.argv.includes('--measure')) {
	for (const row of rows) {
		assert.ok(row.jump < row.naturalBound * 2, `${row.kind}: instantaneous gain change must not make a click`);
		assert.ok(row.maxStep < row.naturalBound * 2, `${row.kind}: the following ramp stays continuous`);
		assert.ok(row.peak < 1, `${row.kind}: output stays unclipped`);
	}
	assert.ok(
		onset.warmupRms > onset.rawRms * 0.8,
		'enabling pitch must keep speech audible while its analysis window fills'
	);
	assert.ok(onset.steadyRms > 0.001, 'pitch processing remains audible after warmup');
}
