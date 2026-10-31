import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import electron from 'electron';

const directory = resolve(process.env.VOICE_HEADROOM_CACHE ?? '.cache/voice-effect-headroom');
await mkdir(directory, { recursive: true });
const bundle = await build({
	stdin: {
		contents:
			"export * from './src/renderer/voice/voicePeakGuard'; export * from './src/renderer/voice/bibiriEcho'; export {createVoiceEffectPreview} from './src/renderer/settings/voiceEffectPreview'; export {voiceEffectDefinitions,getVoiceEffectTuning} from './src/common/VoiceEffectTuning';",
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	format: 'iife',
	globalName: 'effects',
	write: false,
	define: { 'import.meta.env.DEV': 'false' },
	plugins: process.argv.includes('--without-guard')
		? [
				{
					name: 'without-peak-guard',
					setup(build) {
						build.onLoad({ filter: /voicePeakGuard\.ts$/ }, () => ({
							contents:
								'export const createVoicePeakGuard=context=>{const input=context.createGain();return {input,output:input,disconnect(){input.disconnect()}}};export const limitVoicePeak=x=>x;',
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
 globalThis.fetch=async()=>({arrayBuffer:async()=>Uint8Array.from(atob('${impulse}'),c=>c.charCodeAt(0)).buffer});
 const rows=[],rate=48000,length=rate*1.2;
 const voice=new Float32Array(length),harmonics=[];
 for(let f=120;f<6000;f+=120)harmonics.push([f,.03+Math.exp(-(((f-700)/200)**2))+.8*Math.exp(-(((f-1800)/300)**2))]);
 let max=0;for(let i=0;i<length;i++){let v=0;for(const [f,a] of harmonics)v+=a*Math.sin(2*Math.PI*f*i/rate);voice[i]=v;max=Math.max(max,Math.abs(v));}
 const kinds=Object.keys(effects.voiceEffectDefinitions),profiles=kinds.map(kind=>({kind,tuning:effects.getVoiceEffectTuning({},kind)}));
 for(const kind of kinds)profiles.push({kind,tuning:{pitch:0,reverb:0,echo:0}});
 profiles.push({kind:'disguise',tuning:{pitch:-50,reverb:0,echo:0}},{kind:'disguise',tuning:{pitch:50,reverb:0,echo:0}},{kind:'nosRainbowStar',tuning:{pitch:0,reverb:0,echo:100}});
 for(const inputPeak of [.25,.95])for(const {kind,tuning} of profiles){
  const context=new OfflineAudioContext(1,length,rate),preview=await effects.createVoiceEffectPreview(context,kind,tuning);
  const source=context.createBufferSource(),buffer=context.createBuffer(1,length,rate),input=buffer.getChannelData(0);
  for(let i=0;i<length;i++)input[i]=voice[i]*inputPeak/max;
  source.buffer=buffer;source.connect(preview.input);preview.output.connect(context.destination);source.start();
  const data=(await context.startRendering()).getChannelData(0);let peak=0,overflow=0,atRail=0,error=0;
  for(let i=0;i<length;i++){const x=Math.abs(data[i]);if(!Number.isFinite(x))throw Error('Nonfinite');error=Math.max(error,Math.abs(data[i]-input[i]));if(i<rate/2)continue;peak=Math.max(peak,x);if(x>1)overflow++;if(x>=.99999)atRail++;}
  rows.push({kind,tuning,inputPeak,peak,overflow,atRail,error});preview.dispose();
 }
 const context=new OfflineAudioContext(1,rate*4,rate),source=context.createBufferSource(),buffer=context.createBuffer(1,rate,rate);
 for(let i=0;i<rate;i++)buffer.getChannelData(0)[i]=.95*Math.sin(2*Math.PI*100*i/rate);
 source.buffer=buffer;const event=effects.createBibiriEcho(context,source,context.destination);
 const tuning={pitch:0,reverb:0,echo:100};effects.updateBibiriEcho(event,true,false,undefined,100000,tuning);source.start();
 const paused=context.suspend(.9),rendering=context.startRendering();await paused;
 effects.updateBibiriEcho(event,true,true,100000,100900,tuning);await context.resume();
 const samples=(await rendering).getChannelData(0);let eventPeak=0,afterEnd=0;
 for(let i=0;i<samples.length;i++){eventPeak=Math.max(eventPeak,Math.abs(samples[i]));if(i>=rate*3.31)afterEnd=Math.max(afterEnd,Math.abs(samples[i]));}
 effects.disconnectBibiriEcho(event);
 const c=new OfflineAudioContext(1,1024,rate),raw=c.createBuffer(1,1024,rate),s=c.createBufferSource(),guard=effects.createVoicePeakGuard(c);
 for(let i=0;i<1024;i++)raw.getChannelData(0)[i]=(i/1023*2-1)*.79;
 s.buffer=raw;s.connect(guard.input);guard.output.connect(c.destination);s.start();const out=(await c.startRendering()).getChannelData(0);
 let linearError=0;for(let i=0;i<1024;i++)linearError=Math.max(linearError,Math.abs(out[i]-raw.getChannelData(0)[i]));guard.disconnect();
 return {rows,eventPeak,afterEnd,linearError};
})()`;
const server = createServer((_, response) => response.end('<!doctype html>'));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const resultPath = resolve(directory, 'result.json'),
	runner = resolve(directory, 'runner.cjs');
await writeFile(
	runner,
	`const {app,BrowserWindow}=require('electron'),fs=require('node:fs');app.setName('Tanuki-headroom-fixture');app.setPath('userData',${JSON.stringify(resolve(directory, 'profile'))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});await win.loadURL('http://127.0.0.1:${server.address().port}');const rows=await win.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(rows,null,2));app.quit();}catch(e){console.error(e);app.exit(1);}});`
);
const child = spawn(electron, [runner], {
	windowsHide: true,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill(), 60000);
const status = await new Promise((done) => child.on('exit', done));
clearTimeout(timer);
server.close();
assert.equal(status, 0, stderr);
const report = JSON.parse(await readFile(resultPath, 'utf8'));
const sources = {};
for (const file of ['voicePeakGuard', 'sourceFilterProcessor', 'tunedVoiceEffect', 'bibiriEcho', 'AudioController'])
	sources[file] = createHash('sha256')
		.update(await readFile('src/renderer/voice/' + file + '.ts'))
		.digest('hex');
await writeFile(resultPath, JSON.stringify({ checkedAt: new Date().toISOString(), sources, ...report }, null, 2));
console.log(
	JSON.stringify({
		profiles: report.rows.length,
		eventPeak: report.eventPeak,
		afterEnd: report.afterEnd,
		linearError: report.linearError,
	})
);
for (const row of report.rows) {
	assert.ok(
		row.peak < 0.981 && row.overflow === 0 && row.atRail === 0,
		`${row.kind}/${JSON.stringify(row.tuning)}: strong peaks are bounded without flat rails`
	);
	if (row.tuning.pitch === 0 && row.tuning.reverb === 0 && row.tuning.echo === 0)
		assert.equal(row.error, 0, 'neutral including strong .95 input remains sample-exact');
}
assert.ok(report.eventPeak < 0.981, 'live Bibiri feedback is protected after its final envelope');
assert.equal(report.afterEnd, 0, 'live event ends at its existing deadline');
assert.ok(report.linearError < 1e-6, 'ordinary speech keeps its level with no extra processing delay');
