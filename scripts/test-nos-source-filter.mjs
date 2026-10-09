import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import electron from 'electron';

const directory = resolve('.cache/nos-source-filter');
await mkdir(directory, { recursive: true });
const bundled = await build({
	entryPoints: ['src/renderer/voice/sourceFilterEffect.ts'],
	bundle: true,
	format: 'iife',
	globalName: 'effects',
	write: false,
	minify: true,
	target: 'chrome132',
});
const test = `${bundled.outputFiles[0].text}
(async()=>{
 const results=[];
 for(const [rate,pitch,formant,squash] of [[48000,1,1,0],[48000,1.25,1,0],[48000,0.75,1,0],[48000,1,1.35,0],[48000,1,0.75,0],[48000,1.25,1,1],[44100,1,1,0],[16000,1,1,0],[48000,2,1,0]]){
  const ctx=new OfflineAudioContext(1,rate*2,rate);
  await effects.prepareSourceFilter(ctx);
  const fx=effects.createSourceFilterEffect(ctx);
  effects.updateSourceFilterEffect(fx,{pitch,formant,squash});
  const source=ctx.createBufferSource(),buffer=ctx.createBuffer(1,rate*2,rate),data=buffer.getChannelData(0);
  const harmonics=[];
  for(let f=120;f<Math.min(6000,rate/2);f+=120)harmonics.push([f,0.03+Math.exp(-(((f-700)/200)**2))+0.8*Math.exp(-(((f-1800)/300)**2))]);
  let peakInput=0;
  for(let i=0;i<data.length;i++){let value=0;for(const [f,a] of harmonics)value+=a*Math.sin(2*Math.PI*f*i/rate);data[i]=value;peakInput=Math.max(peakInput,Math.abs(value));}
  for(let i=0;i<data.length;i++)data[i]*=0.25/peakInput;
  source.buffer=buffer;source.connect(fx.input);fx.output.connect(ctx.destination);source.start();
  const start=performance.now();const output=(await ctx.startRendering()).getChannelData(0);const elapsed=performance.now()-start;
  const samples=output.slice(rate,rate+Math.floor(rate/2));
  function amplitude(f){let re=0,im=0;for(let i=0;i<samples.length;i++){const ph=2*Math.PI*f*i/rate;re+=samples[i]*Math.cos(ph);im+=samples[i]*Math.sin(ph);}return Math.hypot(re,im)/samples.length;}
  let f0=0,best=0;for(let f=pitch>1.25?180:60;f<=(pitch>1.25?300:175);f++){const a=amplitude(f);if(a>best){best=a;f0=f;}}
  const spectrum=[];for(let f=120*pitch;f<4000;f+=120*pitch)spectrum.push([f,amplitude(f)]);
  function resonance(lo,hi){let f=0,a=0;for(const [freq,value] of spectrum)if(freq>=lo&&freq<=hi&&value>a){a=value;f=freq;}return f;}
  let rms=0,peak=0,error=0;for(let i=rate;i<output.length;i++){const v=output[i];if(!Number.isFinite(v))throw Error('Non-finite audio');rms+=v*v;peak=Math.max(peak,Math.abs(v));error+=(v-data[i-2048])**2;}
  results.push({rate,pitch,formant,squash,f0,f1:resonance(350*formant,1050*formant),f2:resonance(1300*formant,2300*formant),rms:Math.sqrt(rms/rate),peak,error:Math.sqrt(error/rate),elapsed});
  effects.disconnectProcessingEffect(fx);
 }
 const ctx=new OfflineAudioContext(1,48000*2,48000);await effects.prepareSourceFilter(ctx);
 const fx=effects.createSourceFilterEffect(ctx),osc=ctx.createOscillator();osc.frequency.value=200;
 const gain=ctx.createGain();gain.gain.value=0.1;osc.connect(gain);gain.connect(fx.input);fx.output.connect(ctx.destination);osc.start();
 const change=ctx.suspend(0.5),restore=ctx.suspend(1.25),render=ctx.startRendering();
 await change;effects.updateSourceFilterEffect(fx,{pitch:1.25,formant:1.35,squash:1});await ctx.resume();
 await restore;effects.updateSourceFilterEffect(fx,{pitch:1,formant:1,squash:0});await ctx.resume();
 const output=(await render).getChannelData(0);
 for(const sample of output)if(!Number.isFinite(sample)||Math.abs(sample)>=1)throw Error('Invalid transition');
 let error=0;for(let i=84000;i<96000;i++)error+=(output[i]-0.1*Math.sin(2*Math.PI*200*(i-2048)/48000))**2;
 if(Math.sqrt(error/12000)>0.005)throw Error('Source/filter does not restore normal voice');
 effects.disconnectProcessingEffect(fx);
 const silent=new OfflineAudioContext(1,48000,48000);await effects.prepareSourceFilter(silent);
 const silentFx=effects.createSourceFilterEffect(silent);effects.updateSourceFilterEffect(silentFx,{pitch:2,formant:1.7,squash:1});silentFx.output.connect(silent.destination);
 const silence=(await silent.startRendering()).getChannelData(0);for(const sample of silence)if(sample!==0)throw Error('Silence generated noise');effects.disconnectProcessingEffect(silentFx);
 return results;
})()`;
await writeFile(
	resolve(directory, 'runner.cjs'),
	`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});win.webContents.on('console-message',(_event,_level,message)=>console.error(message));await win.loadURL('http://localhost');const result=await win.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(resolve(directory, 'results.json'))},JSON.stringify(result,null,2));app.quit();}catch(error){console.error(error);app.exit(1);}});`
);
// A secure localhost origin enables AudioWorklet without external network access.
// Serve a blank page for the worklet registration test.
const { createServer } = await import('node:http');
const server = createServer((_, res) => res.end('<!doctype html><html></html>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const runner = await readFile(resolve(directory, 'runner.cjs'), 'utf8');
await writeFile(resolve(directory, 'runner.cjs'), runner.replace('http://localhost', `http://127.0.0.1:${port}`));
// Async child execution keeps the local HTTP server responsive.
const { spawn } = await import('node:child_process');
const child = spawn(electron, [resolve(directory, 'runner.cjs')], {
	windowsHide: true,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
const timeout = setTimeout(() => child.kill(), 60000);
const status = await new Promise((resolve) => child.on('exit', resolve));
clearTimeout(timeout);
server.close();
assert.equal(status, 0, stderr);
const results = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
console.log(JSON.stringify(results, null, 2));
for (const row of results) {
	assert.ok(Math.abs(row.f0 - 120 * row.pitch) <= 3, 'source pitch follows its ratio');
	assert.ok(row.rms > 0.001 && row.peak < 1, 'finite audible unclipped output');
}
for (const row of results.filter((row) => row.pitch === 1 && row.formant === 1 && row.squash === 0))
	assert.ok(row.error < 0.0001, 'unity reconstructs original at fixed 2048-sample delay');
assert.ok(results[3].f1 > results[0].f1 && results[4].f1 < results[0].f1, 'formant moves independently of pitch');
for (const index of [1, 2])
	assert.ok(Math.abs(results[index].f2 - results[0].f2) <= 180, 'pitch shift preserves vocal-tract envelope');
assert.ok(results[5].rms < results[1].rms, 'full squash gently reduces volume');
console.log(
	'PASS source/filter: real AudioWorklet registration, pitch/formant separation, squash, unity, sample rates and cleanup'
);
