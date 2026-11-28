// Compare the shipped Rust/Wasm overlay with the pinned Electron React layout.
// Both windows remain hidden; IPC and image data are local synthetic fixtures.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {resolve,join,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import electron from 'electron';
const root=resolve(import.meta.dirname,'..');
const dir=resolve(process.env.TANUKI_OVERLAY_TEST_OUTPUT??join(root,'.tools/receive-jitter-3.2.71-beta3'));
const ui=join(root,'out/tauri-rust-ui');await mkdir(dir,{recursive:true});
const bundle=join(dir,'overlay-reference.js');
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{AvatarOverlay}from'./src/renderer/views/Overlay';const root=createRoot(document.getElementById('app'));window.renderReference=f=>root.render(React.createElement(AvatarOverlay,{gameState:f.game,voiceState:{...f.voice.status.voiceSnapshot,localTalking:f.voice.status.talking,muted:false,deafened:false},position:f.settings.overlayPosition,compactOverlay:f.settings.compactOverlay,playerColors:[['#c51111','#7b0838']]}));`,resolveDir:root,loader:'tsx'},outfile:bundle,bundle:true,platform:'browser',format:'iife',loader:{'.svg':'dataurl','.png':'dataurl','.css':'empty'},plugins:[{name:'local-fixtures',setup(b){
 b.onLoad({filter:/[\\/]views[\\/]Overlay\.tsx$/},async a=>({contents:(await readFile(a.path,'utf8')).replace('const AvatarOverlay:','export const AvatarOverlay:').replace("createRoot(document.getElementById('app')!).render(<Overlay />);",''),loader:'tsx'}));
 b.onResolve({filter:/\/(cosmetics|nosAvatar|nosCosmetics|electron-bridge|contexts|appVariant|LiteAvatar)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',resolveDir:root,contents:a.path.endsWith('/cosmetics')?`export const cosmeticType={base:0,hat:1,hat_back:2,skin:3,visor:4};export const redAlive='/player.png';export const getCosmetic=(c,a,t)=>t===0?'/player.png':'';export const getHatDementions=()=>({top:'0px',left:'0px',width:'100%'});export const useHatsLoaded=()=>true;`:a.path.endsWith('/nosAvatar')?'export const useNosAvatar=()=>undefined;':a.path.endsWith('/nosCosmetics')?'export const useNosBodyMask=()=>undefined;':a.path.endsWith('/contexts')?`import{createContext}from'react';export const PlayerColorContext=createContext([]);`:a.path.endsWith('/appVariant')?'export const isLiteRuntime=()=>false;':a.path.endsWith('/LiteAvatar')?'export default()=>null;':`export const ipcRenderer={on(){},off(){},send(){},invoke:async()=>null};`}));
}}]});
const defaults=JSON.parse(await readFile(join(root,'src-tauri/rust-ui/assets/release-data.json'),'utf8')).defaults;
const hash=b=>createHash('sha256').update(b).digest('hex');
const wasmSha256=hash(await readFile(join(ui,'rust-ui/tbcl_rust_ui_bg.wasm')));
function install(f){
 const callbacks=[];window.fixture=f;
 window.changeFixture=next=>{window.fixture=next;for(const cb of callbacks){cb({payload:{channel:'settings:changed',args:[next.settings]}});cb({payload:{channel:'NOTIFY_GAME_STATE_CHANGED',args:[next.game]}});}};
 window.__TAURI__={event:{listen:async(_,cb)=>{callbacks.push(cb);return()=>{};}},core:{invoke:async(command,args)=>{
  const f=window.fixture;if(command==='native_voice')return args.action==='status'?f.voice:{};
  if(command!=='ipc')return null;switch(args.channel){case'settings:get':return f.settings;case'GET_INITIAL_STATE':return f.game;case'native:context':return{playerColors:[['#c51111','#7b0838']]};case'native:cosmetics-catalog':return{collection:{},snrHats:[],snrVisors:[]};default:return null;}
 }}};
}
function fixture(position,count,compact=false,mod='NONE',talking=true){
 const players=Array.from({length:count},(_,i)=>({id:i,clientId:100+i,isLocal:i===0,name:'Player '+i,colorId:0,shiftedColor:-1,isDead:false,inVent:false,disconnected:false,currentOutfit:0,appearanceHatId:'',appearanceSkinId:'',appearanceVisorId:'',hatId:'',skinId:'',visorId:'',...(mod==='NoS'?{nosCosmetics:{hat:'https://static.localhost/generated/hat.png'}}:{})}));
 const ids=Object.fromEntries(players.map(p=>[p.clientId,'s'+p.clientId]));
 return{settings:{...defaults,enableOverlay:true,meetingOverlay:false,overlayPosition:position,compactOverlay:compact},game:{gameState:1,mod,players},voice:{status:{connected:true,talking,voiceSnapshot:{localIsAlive:true,playerSocketIds:ids,socketClients:Object.fromEntries(players.map(p=>['s'+p.clientId,{clientId:p.clientId}])),audioConnected:Object.fromEntries(players.map(p=>['s'+p.clientId,true])),otherTalking:{},otherDead:{},cloneTalking:{}}}}};
}
const first=fixture('right',13);
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/reference'){res.setHeader('content-type','text/html');res.end('<style>'+await readFile(join(root,'src-tauri/rust-ui/assets/fonts.css'),'utf8')+await readFile(join(root,'src/renderer/css/overlay.css'),'utf8')+'</style><div id="app"></div><script src="/reference.js"></script>');return;}
 if(path==='/reference.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(bundle));return;}
 if(path==='/player.png'){res.setHeader('content-type','image/png');res.end(await readFile(join(root,'static/images/generate/player.png')));return;}
 if(path==='/'){res.setHeader('content-type','text/html');res.end('<div id="app"></div><script>('+install.toString()+')('+JSON.stringify(first)+')</script><script type="module" src="/rust-ui/bootstrap.js"></script>');return;}
 const file=resolve(ui,'.'+path);if(!file.startsWith(ui+sep)){res.writeHead(404).end();return;}
 res.setHeader('content-type',{'.js':'text/javascript','.wasm':'application/wasm','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch(e){res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
function inspect(){
 const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
 const wrapper=document.querySelector('.overlay-wrapper');if(!wrapper)return{count:0,transparent:getComputedStyle(document.body).backgroundColor};
 const children=[...wrapper.querySelectorAll('.player_wrapper')];
 return{count:children.length,size:getComputedStyle(wrapper).getPropertyValue('--size'),wrapper:rect(wrapper),transparent:getComputedStyle(document.body).backgroundColor,rows:children.map(c=>{
  const holder=c.firstElementChild;const avatar=holder.querySelector('.avatar')??[...holder.querySelectorAll('div')].find(n=>getComputedStyle(n).borderRadius==='50%'&&getComputedStyle(n).position==='relative');
  const hat=holder.querySelector('img[src*="hat.png"]');const label=c.querySelector('.playername');const img=holder.querySelector('img.base')??holder.querySelector('img');
  return{holder:rect(holder),avatar:avatar?rect(avatar):null,border:avatar?getComputedStyle(avatar).borderColor:null,label:label?rect(label):null,opacity:label?getComputedStyle(label).opacity:null,text:label?.textContent??null,imageLoaded:!!img?.naturalWidth,hat:hat?rect(hat):null};
 })};
}
const cases=[['right',1],['right',13],['left',20],['right1',13],['left1',13],['top',13],['bottom_left',13],['right',13,true],['hidden',13],['right',13,false,'NoS'],['right',13,true,'NONE',false]];
const runner=join(dir,'overlay-runner.cjs'),result=join(dir,'overlay-dom.json');
await writeFile(runner,`const{app,BrowserWindow}=require('electron');const fs=require('fs');const sleep=ms=>new Promise(r=>setTimeout(r,ms));app.whenReady().then(async()=>{try{
 const windows=[];for(const reference of[false,true]){const w=new BrowserWindow({show:false,frame:false,width:1600,height:900,transparent:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});windows.push(w);w.webContents.session.webRequest.onBeforeRequest((r,done)=>done(r.url.startsWith('https://static.localhost/')?{redirectURL:${JSON.stringify(origin)}+'/player.png'}:{}));await w.loadURL(${JSON.stringify(origin)}+(reference?'/reference':'/?view=overlay&version=fixture'));await w.webContents.insertCSS('*{transition:none!important}');}
 const rows=[];for(const spec of ${JSON.stringify(cases)}){const f=(${fixture.toString()})(...spec);for(let i=0;i<2;i++){await windows[i].webContents.executeJavaScript((i?'renderReference':'changeFixture')+'('+JSON.stringify(f)+')');}await sleep(550);const pair=[];for(const w of windows){if(w.isVisible())throw Error('A test window became visible');pair.push(await w.webContents.executeJavaScript('('+${JSON.stringify(inspect.toString())}+')()'));}rows.push({spec,rust:pair[0],electron:pair[1]});if(spec[0]==='right'&&spec[1]===13&&!spec[2])fs.writeFileSync(${JSON.stringify(join(dir,'overlay-right-13.png'))},(await windows[0].webContents.capturePage()).toPNG());}
 fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(rows,null,2));for(const w of windows)w.destroy();app.exit(0);
 }catch(e){console.error(e.stack);app.exit(1);}});`.replace('const f=('+fixture.toString()+')','const defaults='+JSON.stringify(defaults)+';const f=('+fixture.toString()+')'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
try{
 const child=spawn(electron,[runner],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const timer=setTimeout(()=>child.kill(),45000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);assert.equal(code,0,output);
 const rows=JSON.parse(await readFile(result,'utf8'));
 for(const {spec,rust,electron:ref}of rows){
  if(spec[0]==='hidden'){assert.equal(rust.count,0);continue;}
  assert.equal(rust.transparent,'rgba(0, 0, 0, 0)');assert.equal(rust.count,ref.count,JSON.stringify(spec));assert.equal(rust.size,ref.size);
  for(let i=0;i<rust.count;i++){
   const a=rust.rows[i],b=ref.rows[i];assert(a.imageLoaded&&b.imageLoaded,'decoded avatar');
   for(const part of ['holder','avatar','label','hat']){assert.equal(!!a[part],!!b[part],part);if(a[part])for(const dim of ['x','y','width','height'])assert(Math.abs(a[part][dim]-b[part][dim])<1.1,JSON.stringify({spec,i,part,dim,rust:a[part],electron:b[part]}));}
   assert.equal(a.border,b.border);assert.equal(a.text,b.text);assert.equal(a.opacity,b.opacity);
  }
 }
 assert.equal(hash(await readFile(join(ui,'rust-ui/tbcl_rust_ui_bg.wasm'))),wasmSha256);
 await writeFile(join(dir,'overlay-parity.json'),JSON.stringify({passed:true,wasmSha256,cases:rows.length,backgroundOnly:true,usesMouseOrKeyboard:false,rows},null,2)+'\n');
 console.log('PASS hidden Rust/Wasm overlay vs actual Electron React geometry: '+rows.length+' cases');
}finally{await new Promise(r=>server.close(r));}
