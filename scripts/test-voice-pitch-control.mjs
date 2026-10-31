import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import electron from 'electron';

const directory = resolve('.cache/voice-pitch-control');
await mkdir(directory, { recursive: true });
const bundle = await build({
	stdin: {
		contents: "export { createVoiceEffectPreview } from './src/renderer/settings/voiceEffectPreview'; export { voiceEffectDefinitions } from './src/common/VoiceEffectTuning';",
		resolveDir: process.cwd(), loader: 'ts',
	},
	bundle: true, format: 'iife', globalName: 'effects', write: false,
	define: { 'import.meta.env.DEV': 'true' },
});
const browserTest = `${bundle.outputFiles[0].text}
(async()=>{
 const rate=48000, length=rate*2;
 async function render(kind,pitch){
  const context=new OfflineAudioContext(1,length,rate);
  const effect=await effects.createVoiceEffectPreview(context,kind,{pitch,reverb:0,echo:0});
  const source=context.createBufferSource(), buffer=context.createBuffer(1,length,rate);
  const original=buffer.getChannelData(0);
  const base=pitch===0?440:120;
  if(pitch===0){for(let i=0;i<length;i++)original[i]=0.1*Math.sin(2*Math.PI*base*i/rate);}
  else{
   // A voiced signal exercises the formant-preserving processor. A lone sine
   // has no vocal envelope at the transposed bins and is not a voice fixture.
   const harmonics=[];for(let f=base;f<6000;f+=base)
    harmonics.push([f,0.03+Math.exp(-(((f-700)/200)**2))+0.8*Math.exp(-(((f-1800)/300)**2))]);
   let peak=0;
   for(let i=0;i<length;i++){let value=0;for(const [f,a] of harmonics)value+=a*Math.sin(2*Math.PI*f*i/rate);original[i]=value;peak=Math.max(peak,Math.abs(value));}
   for(let i=0;i<length;i++)original[i]*=0.25/peak;
  }
  source.buffer=buffer;source.connect(effect.input);effect.output.connect(context.destination);source.start();
  const rendered=(await context.startRendering()).getChannelData(0);
  let error=0,peak=0;
  for(let i=0;i<rendered.length;i++){
   if(!Number.isFinite(rendered[i]))throw Error(kind+' non-finite audio');
   error=Math.max(error,Math.abs(rendered[i]-original[i]));peak=Math.max(peak,Math.abs(rendered[i]));
  }
  const samples=rendered.slice(rate,rate+rate/2), expected=base*2**(pitch/100);
  let frequency=0,best=0;
  for(let f=Math.floor(expected)-8;f<=Math.ceil(expected)+8;f++){
   let re=0,im=0;
   for(let i=0;i<samples.length;i++){const angle=2*Math.PI*f*i/rate;re+=samples[i]*Math.cos(angle);im+=samples[i]*Math.sin(angle);}
   const power=re*re+im*im;if(power>best){best=power;frequency=f;}
  }
  effect.dispose();
  return {kind,pitch,expected,frequency,error,peak,power:best};
 }
 const bypass=[];for(const kind of Object.keys(effects.voiceEffectDefinitions))bypass.push(await render(kind,0));
 const signed=[];for(const pitch of [-100,-50,50,100])signed.push(await render('disguise',pitch));
 return {bypass,signed};
})()`;
const impulse = await readFile('static/sounds/reverb.ogx');
const server = createServer((request, response) => {
	if (request.url === '/sounds/reverb.ogx') {
		response.setHeader('Content-Type', 'audio/ogg');
		response.end(impulse);
	} else response.end('<!doctype html><meta charset="utf-8">');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const resultPath = resolve(directory, 'result.json');
const runnerPath = resolve(directory, 'runner.cjs');
await writeFile(runnerPath, `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setName('Tanuki-voice-pitch-fixture');app.setPath('userData',${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({show:false});await window.loadURL(${JSON.stringify(origin)});
 const result=await window.webContents.executeJavaScript(${JSON.stringify(browserTest)});
 fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result,null,2));app.quit();
}catch(error){console.error(error);app.exit(1);}});
`);
const child = spawn(electron, [runnerPath], {
	windowsHide: true,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
const timeout = setTimeout(() => child.kill(), 60000);
const status = await new Promise((done) => child.on('exit', done));
clearTimeout(timeout);
server.close();
assert.equal(status, 0, stderr);
const results = JSON.parse(await readFile(resultPath, 'utf8'));
assert.equal(results.bypass.length, 11);
for (const row of results.bypass) assert.ok(row.error < 1e-6, `${row.kind}: all-zero profile is original audio without processing delay`);
for (const row of results.signed) {
	assert.ok(Math.abs(row.frequency - row.expected) <= 2, `pitch ${row.pitch}: expected ${row.expected}Hz, got ${row.frequency}Hz`);
	assert.ok(row.power > 1 && row.peak < 1, 'audible, unclipped pitch-shifted output');
}
const sources = {};
for (const file of [
	'src/common/VoiceEffectTuning.ts', 'src/renderer/settings/voiceEffectPreview.ts',
	'src/renderer/voice/tunedVoiceEffect.ts', 'src/renderer/voice/sourceFilterEffect.ts',
	'src/renderer/voice/sourceFilterProcessor.ts', 'src/renderer/voice/berserkerEffect.ts',
	'src/renderer/voice/reverbMix.ts',
]) sources[file] = createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(resultPath, JSON.stringify({ verifiedAt: new Date().toISOString(), sources, ...results }, null, 2));
console.log(JSON.stringify({ zeroProfiles: results.bypass.length, maxBypassError: Math.max(...results.bypass.map((row) => row.error)), signed: results.signed }, null, 2));
console.log('PASS actual preview audio: all eleven neutral profiles bypass unchanged; signed pitch shifts lower/higher at four settings');
