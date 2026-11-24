import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import electron from 'electron';

const directory = resolve('.cache/snr-image-recovery');
await mkdir(directory, { recursive: true });
const harness = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import Avatar from './src/renderer/components/Avatar';
const names=['transient','permanent','detached','changed','secondary','unrelated'];
const root=createRoot(document.getElementById('app'));
flushSync(()=>root.render(React.createElement('main',null,names.map((name,id)=>React.createElement('section',{key:id,'data-case':name},React.createElement(Avatar,{player:{id,clientId:id+1,name,colorId:0,currentOutfit:0,appearanceHatId:'',appearanceSkinId:'',appearanceVisorId:'',appearanceColorId:0,hatId:name==='secondary'?'':'Modded_'+name,skinId:'',visorId:'',snrVisor2Id:name==='secondary'?'Modded_secondary':undefined},size:80,talking:false,isAlive:true,mod:'SUPER_NEW_ROLES',borderColor:'#fff',socketConfig:{volume:1,isMuted:false},onConfigChange:()=>{}}))))));
const images=names.map(name=>({name,image:[...document.querySelector('[data-case="'+name+'"]').querySelectorAll('img')].find(i=>i.src.startsWith('snr-cosmetic:')||i.src.startsWith('other-cosmetic:'))}));
setTimeout(()=>{images.find(i=>i.name==='detached').image.closest('section').remove();images.find(i=>i.name==='changed').image.src='snr-cosmetic://hat-front/Modded_changed-success?color=0';},100);
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const snapshot=()=>images.map(({name,image})=>({name,width:image.naturalWidth,display:image.style.display,retries:image.dataset.snrRetries??null,connected:image.isConnected}));
globalThis.__done=(async()=>{await sleep(1800);const settled=snapshot();await sleep(1300);const stable=snapshot();flushSync(()=>root.unmount());return{settled,stable};})();`;
const mocks = {
	'../lib/cosmetics': `export const cosmeticType={base:'base',hat:'hat',hat_back:'hat_back',skin:'skin',visor:'visor'};export const redAlive='data:,';export const useHatsLoaded=()=>1;export const getHatDementions=()=>({top:'0',width:'100%',left:'0'});export const getCosmetic=(_c,_a,type,id)=>type==='base'?'data:,' : id&&(type==='hat'||type==='visor')?(id.includes('unrelated')?'other-cosmetic':'snr-cosmetic')+'://'+(type==='visor'?'visor':'hat-front')+'/'+id+'?color=0':'';`,
	'../lib/nosAvatar': 'export const useNosAvatar=()=>undefined;',
	'../lib/nosCosmetics': 'export const useNosBodyMask=()=>undefined;',
	'../LiteAvatar': 'export default function LiteAvatar(){return null;}',
	'../../common/appVariant': 'export const isLiteRuntime=()=>false;',
};
const result = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), loader: 'tsx' },
	bundle: true,
	format: 'iife',
	write: false,
	define: { 'process.env.NODE_ENV': '"development"' },
	loader: { '.svg': 'dataurl' },
	plugins: [
		{
			name: 'avatar-mocks',
			setup(b) {
				b.onResolve({ filter: /.*/ }, (args) =>
					mocks[args.path]
						? { path: args.path, namespace: 'mock' }
						: args.path.startsWith('@mui/')
							? { path: args.path, namespace: 'mui' }
							: undefined
				);
				b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path] }));
				b.onLoad({ filter: /.*/, namespace: 'mui' }, () => ({
					contents: `import React from 'react';export const Tooltip=({children})=>children;export default function Box({component='div',sx,style,children,...props}){return React.createElement(component,{...props,style:{...sx,...style}},children);}`,
					resolveDir: process.cwd(),
				}));
				if (process.env.TANUKI_AVATAR_BASELINE)
					b.onLoad({ filter: /[\\/]Avatar\.tsx$/ }, async (args) => ({
						contents: await readFile(process.env.TANUKI_AVATAR_BASELINE, 'utf8'),
						loader: 'tsx',
						resolveDir: resolve(args.path, '..'),
					}));
			},
		},
	],
});
await writeFile(join(directory, 'harness.js'), result.outputFiles[0].contents);
await writeFile(join(directory, 'index.html'), '<!doctype html><div id="app"></div>');
const runner = `const {app,BrowserWindow,protocol}=require('electron');const fs=require('node:fs');
protocol.registerSchemesAsPrivileged(['snr-cosmetic','other-cosmetic'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true}})));
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async()=>{try{const counts={};const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
for(const scheme of ['snr-cosmetic','other-cosmetic'])protocol.handle(scheme,request=>{const id=new URL(request.url).pathname.slice(1);counts[id]=(counts[id]??0)+1;const fail=/permanent|detached|unrelated/.test(id)||(!id.includes('success')&&counts[id]===1);return fail?new Response(null,{status:404,headers:{'Cache-Control':'no-store'}}):new Response(png,{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});});
const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await window.loadFile(${JSON.stringify(join(directory, 'index.html'))});await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(join(directory, 'harness.js'))},'utf8'));const result=await window.webContents.executeJavaScript('globalThis.__done');fs.writeFileSync(${JSON.stringify(join(directory, 'result.json'))},JSON.stringify({...result,counts},null,2));app.exit(0);}catch(error){console.error(error.stack);app.exit(1);}});`;
await writeFile(join(directory, 'runner.cjs'), runner);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
	const ran = spawnSync(electron, [join(directory, 'runner.cjs')], {
		env,
		windowsHide: true,
		encoding: 'utf8',
		timeout: 30000,
		maxBuffer: 1024 * 1024,
	});
	assert.equal(ran.status, 0, ran.stdout + ran.stderr);
	const proof = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
	for (const name of ['transient', 'secondary', 'changed']) {
		const image = proof.stable.find((i) => i.name === name);
		assert.ok(image.width > 0, `${name}: production Avatar decodes after a temporary failure`);
		assert.notEqual(image.display, 'none');
		assert.equal(image.retries, null);
	}
	assert.deepEqual(proof.stable, proof.settled);
	assert.equal(proof.counts.Modded_transient, 2);
	assert.equal(proof.counts.Modded_secondary, 2);
	assert.equal(proof.counts.Modded_permanent, 3);
	assert.equal(proof.counts.Modded_detached, 1);
	assert.equal(proof.counts.Modded_changed, 1);
	assert.equal(proof.counts.Modded_unrelated, 1);
	console.log(
		'PASS actual React Avatar handlers (MUI layout mocked): transient/secondary recovery, two-retry limit, detach/source guard and unrelated images'
	);
} finally {
	await rm(join(directory, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
