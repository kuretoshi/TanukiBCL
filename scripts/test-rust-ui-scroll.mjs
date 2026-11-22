// Run the real Rust/Wasm UI in an isolated browser with synthetic IPC only.
// No user's profile, microphone, credentials, game process or BAN server is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename, extname, sep } from 'node:path';
import electron from 'electron';

const root=resolve(import.meta.dirname,'..'), ui=join(root,'out/tauri-rust-ui');
const tempBase=resolve(tmpdir()), directory=await mkdtemp(join(tempBase,'tanuki-scroll-ui-'));
const defaults=JSON.parse(await readFile(join(root,'src-tauri/rust-ui/assets/release-data.json'),'utf8')).defaults;
const server=createServer(async(request,response)=>{
  const path=new URL(request.url,'http://127.0.0.1').pathname;
  if(path==='/'){
    response.setHeader('Content-Type','text/html');
    response.end('<!doctype html><html><body><div id="app"></div><script type="module">import init from "/rust-ui/tbcl_rust_ui.js";await init();</script></body></html>');return;
  }
  const file=resolve(ui,'.'+path);
  if(!file.startsWith(ui+sep)){response.writeHead(404).end();return;}
  try{
    const bytes=await readFile(file);
    response.setHeader('Content-Type',({'.wasm':'application/wasm','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png'})[extname(file)]??'application/octet-stream');
    response.end(bytes);
  }catch{response.writeHead(404).end();}
});
function mockBackend(defaults){
  let sequence=0;
  const listeners=[];
  const game={mod:'NONE',players:[],gameState:0,isHost:false,lobbyCode:'TEST',longText:Array.from({length:300},(_,i)=>'JSON row '+i+' '+ 'x'.repeat(200))};
  const bans={bans:[],pending:[],historyAvailable:true,ipBansAvailable:false,historyTotal:200,history:Array.from({length:200},(_,i)=>({uid_digest:'fixture-'+i,display_name:'Synthetic player '+i,public_ip:'',uid_banned:0,first_seen_at:1000,last_seen_at:2000}))};
  window.__scrollProbe={
    sequence:()=>sequence,
    emit:()=>listeners.forEach(cb=>cb({payload:{channel:'ERROR',args:['Synthetic background update '+(++sequence)]}})),
  };
  window.__TAURI__={
    event:{listen:async(_name,cb)=>{listeners.push(cb);return ()=>{};}},
    core:{invoke:async(command,args)=>{
      if(command==='native_voice'){
        if(args.action==='status')return {status:{voiceSnapshot:{sequence:++sequence},padding:game.longText}};
        return {};
      }
      if(command!=='ipc')return null;
      switch(args.channel){
        case 'settings:get':return defaults;
        case 'GET_INITIAL_STATE':return game;
        case 'native:context':return {};
        case 'native:cosmetics-catalog':return {collection:{}};
        case 'updater:get-state':return {state:'idle'};
        case 'VOICE_STONE_LOCAL_STATUS':return {runtimeInstalled:false,available:false,enabled:false,error:''};
        case 'debug:player-bans':if(args.args[0]?.action!=='list')throw Error('Fixture permits list only');return bans;
        case 'debug:get-logs':return Array.from({length:200},(_,i)=>'Synthetic log '+i).join('\n');
        default:return null;
      }
    }},
  };
}
async function exercise(view){
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const require=(ok,message)=>{if(!ok)throw Error(message);};
  async function waitFor(test,message){for(let i=0;i<150;i++){if(test())return;await pause(20);}throw Error(message);}
  await waitFor(()=>window.__scrollProbe&&document.querySelector('[data-scroll-key]'),'UI did not initialize');
  if(view==='settings'){
    document.querySelector('[data-action=category][data-value=advanced]').click();
    await waitFor(()=>document.querySelector('[data-action=stone-local-toggle]'),'Advanced settings did not open');
  }else{
    if(view==='debug'){
      for(const id of ['bans','game','voice'])document.querySelector('[data-debug-section='+id+']').open=true;
      await pause(80);
    }
    const password=document.querySelector('[data-form=banPassword]');
    password.value='synthetic-fixture-only';password.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-action=ban-list]').click();
    await waitFor(()=>document.body.textContent.includes('Synthetic player 199'),'Synthetic list did not load');
  }
  await pause(150);
  document.activeElement?.blur();
  const keys=view==='debug'?['debug-panel','ban-history','debug-game','debug-voice']:view==='settings'?['settings-content']:['history-panel'];
  const saved=keys.map(key=>{
    const node=document.querySelector('[data-scroll-key="'+key+'"]');
    require(node,'Missing scroll pane '+key);
    require(node.scrollHeight>node.clientHeight+100,'Pane is not scrollable '+key);
    node.scrollTop=key===keys[0]?550:120;
    if(node.scrollWidth>node.clientWidth+30)node.scrollLeft=30;
    return {key,top:node.scrollTop,left:node.scrollLeft};
  });
  // Focus restoration must not move the settings viewport to an offscreen field.
  if(view==='settings')document.querySelector('[data-setting=serverURL]').focus({preventScroll:true});
  let replaced=0;
  for(let i=0;i<5;i++){
    const before=document.querySelector('[data-scroll-key="'+keys[0]+'"]');
    window.__scrollProbe.emit();await pause(80);
    if(before!==document.querySelector('[data-scroll-key="'+keys[0]+'"]'))replaced++;
    for(const expected of saved){
      const node=document.querySelector('[data-scroll-key="'+expected.key+'"]');
      require(node&&Math.abs(node.scrollTop-expected.top)<=1&&Math.abs(node.scrollLeft-expected.left)<=1,view+': scroll reset in '+expected.key+' (wanted '+expected.top+', got '+node?.scrollTop+')');
    }
  }
  require(replaced===5,'Test did not exercise DOM replacement');
  // Also survive the genuine one-second status polling loop used by the app.
  await pause(1300);
  for(const expected of saved){
    const node=document.querySelector('[data-scroll-key="'+expected.key+'"]');
    require(node&&Math.abs(node.scrollTop-expected.top)<=1,view+': periodic status update reset '+expected.key);
  }
  return {view,panes:saved.map(p=>p.key),replacements:replaced};
}
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const preload=join(directory,'preload.cjs'),runner=join(directory,'runner.cjs');
  await writeFile(preload,'('+mockBackend.toString()+')('+JSON.stringify(defaults)+');');
  await writeFile(runner,`
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory,'profile'))});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{try{
 const results=[];
 for(const view of ['debug','settings','player-history']){
  const window=new BrowserWindow({show:false,width:900,height:500,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  window.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:!request.url.startsWith(${JSON.stringify(origin+'/')})&&!request.url.startsWith('data:')}));
  await window.loadURL(${JSON.stringify(origin)}+'/?view='+view+'&version=test');
  results.push(await window.webContents.executeJavaScript('('+${JSON.stringify(exercise.toString())}+')('+JSON.stringify(view)+')'));
  window.destroy();
 }
 console.log('RESULT:'+JSON.stringify(results));app.exit(0);
}catch(error){console.error(error.stack||error);app.exit(1);}});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const outcome=await new Promise(resolve=>{
    const child=spawn(electron,[runner],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const timeout=setTimeout(()=>child.kill(),45000);
    child.on('close',code=>{clearTimeout(timeout);resolve({code,output});});
    child.on('error',error=>{clearTimeout(timeout);resolve({code:-1,output:String(error)});});
  });
  assert.equal(outcome.code,0,outcome.output);
  const result=outcome.output.split(/\r?\n/).find(line=>line.startsWith('RESULT:'));
  assert(result,outcome.output);assert.equal(JSON.parse(result.slice(7)).length,3);
  console.log('PASS real Rust/Wasm UI: debug, history and settings scroll positions survive repeated DOM replacements, nested panes, focus restoration and periodic status updates');
}finally{
  await new Promise(resolve=>server.close(resolve));
  if(dirname(directory)!==tempBase||!basename(directory).startsWith('tanuki-scroll-ui-'))throw Error('Unexpected test directory');
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
