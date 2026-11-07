import{readFile,writeFile}from'node:fs/promises';import{transform}from'esbuild';import vm from'node:vm';import{resolve,join}from'node:path';
const root=resolve(import.meta.dirname,'..');const source=await readFile(join(root,'src/renderer/views/playerGridLayout.ts'),'utf8');
const compiled=await transform(source,{loader:'ts',format:'cjs'});const module={exports:{}};vm.runInNewContext(compiled.code,{module,exports:module.exports});
const cases=[];for(const width of [216,256,456,876])for(const height of [100,180,300,500])for(let count=0;count<=30;count++)for(const split of [null,0,Math.floor(count/2),count])cases.push({width,height,count,split,...module.exports.getPlayerGridLayout(width,height,count,split??undefined)});
await writeFile(join(root,'src-tauri/rust-ui/assets/player-grid-goldens.json'),JSON.stringify(cases));console.log(`Exported ${cases.length} grid cases directly from the existing Electron function.`);
