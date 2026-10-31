import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import electron from 'electron';

const directory = resolve('.cache/voice-effect-tuning-settings');
await mkdir(directory, { recursive: true });
const storeBuild = await build({
	entryPoints: ['src/main/settingsStore.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	packages: 'external',
	write: false,
	plugins: [
		{
			name: 'isolated-store-name',
			setup(builder) {
				builder.onResolve({ filter: /common[/\\]appVariant$/ }, () => ({ path: 'variant', namespace: 'mock' }));
				builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
					contents:
						'export const getVariantStoreName=()=>"voice-effect-settings-fixture"; export const isLiteRuntime=()=>false;',
				}));
			},
		},
	],
});
await writeFile(resolve(directory, 'settings-store.mjs'), storeBuild.outputFiles[0].contents);
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ThemeProvider} from '@mui/material/styles';
import theme from './src/renderer/lib/theme';
import VoiceEffectsSection from './src/renderer/settings/sections/VoiceEffectsSection';
import translation from './static/locales/ja/translation.json';
const root=createRoot(document.getElementById('app'));
let settings, game={mod:'NoS',nosAddonIds:['UchuAddon','tanuki.bcl.roles']};
globalThis.changes=[];globalThis.previewCalls=[];globalThis.previewUpdates=[];globalThis.previewDisposed=0;
const t=key=>key.split('.').reduce((value,part)=>value?.[part],translation)??key;
const draw=()=>flushSync(()=>root.render(React.createElement(ThemeProvider,{theme},
 React.createElement(VoiceEffectsSection,{t,settings,gameState:game,setSettings:(key,value,persist)=>{
  changes.push({key,value:structuredClone(value),persist});settings={...settings,[key]:value};draw();
 }}))));
globalThis.configure=(value,mod='NoS',addons=['UchuAddon','tanuki.bcl.roles'])=>{
 settings=value;game={mod,nosAddonIds:addons};draw();
};
globalThis.inspect=()=>({
 options:[...document.querySelectorAll('option')].map(node=>node.value),
 selected:document.querySelector('select')?.value,
 sliders:[...document.querySelectorAll('input[type=range]')].map(node=>({
  value:Number(node.value),min:Number(node.min),max:Number(node.max),label:node.getAttribute('aria-label'),
 })),
 text:document.body.innerText,scrollWidth:document.documentElement.scrollWidth,width:innerWidth,
});
globalThis.selectEffect=id=>{
 const select=document.querySelector('select');select.value=id;
 select.dispatchEvent(new Event('change',{bubbles:true}));
};
globalThis.setSlider=(index,value)=>{
 const input=document.querySelectorAll('input[type=range]')[index];
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
 input.dispatchEvent(new Event('input',{bubbles:true}));
 input.dispatchEvent(new Event('change',{bubbles:true}));
};
globalThis.clickPreview=()=>document.querySelector('button').click();
globalThis.snapshotSettings=()=>structuredClone(settings);
globalThis.AudioContext=class {
 createMediaStreamSource(){return {connect(){},disconnect(){}};}
 createMediaStreamDestination(){return {stream:new MediaStream()};}
 close(){return Promise.resolve();}
};
HTMLMediaElement.prototype.play=()=>Promise.resolve();
HTMLMediaElement.prototype.pause=()=>{};
HTMLMediaElement.prototype.setSinkId=()=>Promise.resolve();
`;
const renderer = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), loader: 'tsx' },
	bundle: true,
	format: 'iife',
	write: false,
	plugins: [
		{
			name: 'no-hardware-preview',
			setup(builder) {
				builder.onResolve({ filter: /captureMicrophone$/ }, () => ({ path: 'capture', namespace: 'mock' }));
				builder.onResolve({ filter: /voiceEffectPreview$/ }, () => ({ path: 'preview', namespace: 'mock' }));
				builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
					contents:
						path === 'capture'
							? 'export async function captureMicrophone(){if(globalThis.holdCapture) await new Promise(resolve=>globalThis.releaseCapture=resolve);return {stream:new MediaStream()};}'
							: `export async function createVoiceEffectPreview(context,kind,tuning){
 globalThis.previewCalls.push({kind,tuning:structuredClone(tuning)});
 return {input:{connect(){},disconnect(){}},output:{connect(){},disconnect(){}},
 update:value=>globalThis.previewUpdates.push({kind,tuning:structuredClone(value)}),
 dispose:()=>globalThis.previewDisposed++};}`,
				}));
			},
		},
	],
});
await writeFile(resolve(directory, 'harness.js'), renderer.outputFiles[0].contents);
await writeFile(
	resolve(directory, 'index.html'),
	'<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#25232a;color:white}</style><div id="app"></div>'
);
const runner = `
const {app,BrowserWindow,ipcMain}=require('electron');
const {pathToFileURL}=require('node:url');const fs=require('node:fs');const path=require('node:path');
const assert=require('node:assert/strict');const directory=${JSON.stringify(directory)};
app.setName('Tanuki-voice-tuning-settings-fixture');
app.setPath('userData',path.join(directory,'profile'));
fs.mkdirSync(app.getPath('userData'),{recursive:true});
const legacy={voiceEffectStrength:35,nosRokurokubiVoiceEffectStrength:45,
 voiceEffectTunings:{nosCitrus:{pitch:10,reverb:15,echo:20}},
 __internal__:{migrations:{version:'3.2.59'}}};
fs.writeFileSync(path.join(app.getPath('userData'),'voice-effect-settings-fixture.json'),JSON.stringify(legacy));
app.whenReady().then(async()=>{
 let window;
 try{
  const {settingsStore,initSettingsIpc}=await import(pathToFileURL(path.join(directory,'settings-store.mjs')).href);
  initSettingsIpc();
  const get=()=>ipcMain._invokeHandlers.get('settings:get')({});
  const set=(key,value,persist)=>ipcMain.listeners('settings:set')[0]({},key,value,persist);
  assert.deepEqual(settingsStore.get('voiceEffectTunings'),legacy.voiceEffectTunings);
  assert.equal(settingsStore.get('voiceEffectStrength'),35);
  assert.equal(settingsStore.get('nosRokurokubiVoiceEffectStrength'),45);
  for(const [id,value] of [
   ['disguise',{pitch:-100,reverb:0,echo:100}],['nosSize',{pitch:100,reverb:100,echo:0}],
   ['snrPush',{pitch:0,reverb:0,echo:0}],['nosBibiri',{pitch:25}],
  ]) settingsStore.set('voiceEffectTunings',{...settingsStore.get('voiceEffectTunings'),[id]:value});
  const valid=settingsStore.get('voiceEffectTunings');
  for(const invalid of [
   {disguise:{pitch:-101}},{disguise:{pitch:101}},{disguise:{reverb:-1}},
   {disguise:{reverb:101}},{disguise:{echo:-1}},{disguise:{echo:101}},
   {disguise:{unexpected:1}},{unknownRole:{pitch:0}},
  ]) assert.throws(()=>settingsStore.set('voiceEffectTunings',invalid));
  assert.deepEqual(settingsStore.get('voiceEffectTunings'),valid);
  settingsStore.set('voiceEffectTunings',legacy.voiceEffectTunings);
  window=new BrowserWindow({show:false,width:750,height:630,useContentSize:true,
    webPreferences:{backgroundThrottling:false}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));
  await window.loadFile(path.join(directory,'index.html'));
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(directory,'harness.js'),'utf8'));
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const pause=()=>evaluate('new Promise(resolve=>setTimeout(resolve,25))');
  const configure=async(mod='NoS',addons=['UchuAddon','tanuki.bcl.roles'])=>{
    await evaluate('configure('+JSON.stringify(get())+','+JSON.stringify(mod)+','+JSON.stringify(addons)+')');await pause();
  };
  const inspect=()=>evaluate('inspect()');
  const select=async id=>{await evaluate('selectEffect('+JSON.stringify(id)+')');await pause();};
  const slider=async(index,value)=>{
    await evaluate('setSlider('+index+','+value+')');await pause();
    let changes=await evaluate('changes.splice(0)');
    if(!changes.length){
      await evaluate('document.querySelectorAll("input[type=range]")['+index+'].focus()');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});await pause();
      await evaluate('setSlider('+index+','+value+')');await pause();
      changes=await evaluate('changes.splice(0)');
    }
    assert.ok(changes.length,'real MUI slider must call the production section handler');
    for(const change of changes)set(change.key,change.value,change.persist);
    return changes;
  };
  await configure();
  assert.equal((await inspect()).sliders.length,3);
  assert.deepEqual((await inspect()).sliders.map(({min,max})=>[min,max]),[[-100,100],[0,100],[0,100]]);
  assert.equal((await inspect()).sliders[0].value,-35,'legacy preset displayed without migration');
  await select('nosRokurokubi');
  assert.deepEqual((await inspect()).sliders.map(({value})=>value),[45,0,0,100,35,50]);
  await slider(3,80);await slider(4,25);await slider(5,75);
  assert.deepEqual(get().rokuroVoice,{headVolume:80,bodyVolume:25,bodyEcho:75});
  await slider(0,-100);await slider(1,40);await slider(2,25);
  const first=await evaluate('snapshotSettings().voiceEffectTunings.nosRokurokubi');
  assert.deepEqual(first,{pitch:-100,reverb:40,echo:25});
  await select('nosCitrus');
  assert.deepEqual((await inspect()).sliders.map(({value})=>value),[10,15,20]);
  await slider(0,100);await slider(2,60);
  await select('nosRokurokubi');
  assert.deepEqual((await inspect()).sliders.map(({value})=>value),[-100,40,25,80,25,75]);
  assert.equal(settingsStore.get('voiceEffectStrength'),35);
  assert.equal(settingsStore.get('nosRokurokubiVoiceEffectStrength'),45,'legacy key remains untouched');
  await evaluate('clickPreview()');await pause();
  assert.deepEqual((await evaluate('previewCalls')).at(-1),{kind:'nosRokurokubi',tuning:first});
  await slider(0,0);await slider(1,0);await slider(2,0);
  const neutral={pitch:0,reverb:0,echo:0};
  assert.deepEqual((await evaluate('previewUpdates')).at(-1),{kind:'nosRokurokubi',tuning:neutral});
  assert.deepEqual(get().voiceEffectTunings.nosRokurokubi,neutral);
  assert.equal((await inspect()).text.includes('0で元の音程'),true);
  assert.equal((await inspect()).text.includes('すべて0'),true);
  const disposed=await evaluate('previewDisposed');
  await select('nosCitrus');
  assert.ok(await evaluate('previewDisposed')>disposed,'changing effect stops the prior preview');
  await evaluate('holdCapture=true;clickPreview()');await pause();
  await slider(0,0);
  await evaluate('releaseCapture();holdCapture=false');await pause();
  assert.equal((await evaluate('previewCalls')).at(-1).tuning.pitch,0,'pending capture uses latest controls');
  await select('disguise');
  const cases=[];
  for(const [mod,addons,expected] of [
    ['NoS',['UchuAddon','tanuki.bcl.roles'],9],['NoS',[],4],
    ['SUPER_NEW_ROLES',[],3],['NONE',[],1],
  ]){
    await configure(mod,addons);const state=await inspect();
    assert.equal(state.options.length,expected);
    assert.equal(state.sliders.length,state.selected==='nosRokurokubi'?6:3);
    assert.ok(state.scrollWidth<=state.width,'no horizontal overflow');
    cases.push({mod,addons,...state});
  }
  await configure();await select('nosRokurokubi');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(directory,'settings-750x630.png'),(await window.capturePage()).toPNG());
  window.setContentSize(620,440);await pause();
  const narrow=await inspect();assert.ok(narrow.scrollWidth<=narrow.width,'minimum settings width has no horizontal overflow');
  const stored=JSON.parse(fs.readFileSync(settingsStore.path,'utf8'));
  assert.deepEqual(stored.voiceEffectTunings.nosRokurokubi,neutral);
  assert.deepEqual(stored.voiceEffectTunings.nosCitrus,{pitch:0,reverb:15,echo:60});
  assert.equal(stored.voiceEffectStrength,35);assert.equal(stored.nosRokurokubiVoiceEffectStrength,45);
  const committed=stored.voiceEffectTunings;
  set('voiceEffectTunings',{...committed,disguise:{pitch:-25,reverb:0,echo:0}},false);
  assert.deepEqual(settingsStore.get('voiceEffectTunings'),committed,'preview drag does not persist prematurely');
  assert.equal(get().voiceEffectTunings.disguise.pitch,-25);
  set('voiceEffectTunings',{...committed,disguise:{pitch:-25,reverb:0,echo:0}},true);
  assert.equal(settingsStore.get('voiceEffectTunings').disguise.pitch,-25);
  const Store=(await import('electron-store')).default;
  const reloaded=new Store({name:'voice-effect-settings-fixture'});
  assert.deepEqual(reloaded.get('voiceEffectTunings'),settingsStore.get('voiceEffectTunings'),'real disk round-trip');
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({cases,narrow,
   stored:reloaded.store,previewCalls:await evaluate('previewCalls'),previewUpdates:await evaluate('previewUpdates'),
   noMicrophoneOrOutputDeviceUsed:true},null,2));
  assert.equal(window.isVisible(),false);
  window.destroy();app.exit(0);
 }catch(error){console.error(error);if(window&&!window.isDestroyed())window.destroy();app.exit(1);}
});
app.on('window-all-closed',()=>{});
`;
await writeFile(resolve(directory, 'runner.cjs'), runner);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [resolve(directory, 'runner.cjs')], {
	env,
	windowsHide: true,
	encoding: 'utf8',
	timeout: 60000,
	maxBuffer: 2 * 1024 * 1024,
});
assert.equal(run.status, 0, run.stdout + run.stderr + String(run.error || ''));
const outcomes = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
assert.equal(outcomes.noMicrophoneOrOutputDeviceUsed, true);
console.log(
	'PASS effect tuning settings: real Chromium 3-axis UI, per-role isolation, live/pending preview arguments, native schema bounds, legacy preservation and disk persistence'
);
