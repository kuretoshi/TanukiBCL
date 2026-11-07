// Build-time extraction only. No Electron/Node backend is started and no user
// profile is opened. Runtime resources are plain JSON consumed by Rust.
import {build} from 'esbuild';
import {resolve} from 'node:path';
export async function releaseData(root=resolve(import.meta.dirname,'..')){
 const result=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:"export {settingsStore} from './src/main/settingsStore'; export {DefaultGamePlatforms} from './src/common/GamePlatform'; export {DEFAULT_PLAYERCOLORS} from './src/common/playerColors';"},bundle:true,write:false,platform:'node',format:'esm',logLevel:'warning',define:{'process.env.BETTERCREWLINK_LITE':'"0"'},plugins:[{name:'read-only-release-schema',setup(plugin){
  plugin.onResolve({filter:/^(electron-store|electron)$/},args=>({path:args.path,namespace:'release-schema'}));
  plugin.onLoad({filter:/.*/,namespace:'release-schema'},args=>({loader:'js',contents:args.path==='electron'?`export const ipcMain={handle(){},on(){}};export const BrowserWindow={getAllWindows(){return []}};`:`
   const clone=v=>v===undefined?undefined:structuredClone(v);
   function defaults(schema,value){if(value===undefined)value=clone(schema.default);if(schema.type==='object'&&value&&typeof value==='object'){for(const[key,child]of Object.entries(schema.properties??{})){const next=defaults(child,value[key]);if(next!==undefined)value[key]=next;}}return value;}
   export default class Store{constructor(options){this.store={};for(const[key,schema]of Object.entries(options.schema)){const value=defaults(schema,undefined);if(value!==undefined)this.store[key]=value;}}get(key,fallback){return this.store[key]??fallback;}has(key){return Object.hasOwn(this.store,key);}set(key,value){this.store[key]=value;}delete(key){delete this.store[key];}}
  `}));
 }}]});
 const module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
 const defaults=structuredClone(module.settingsStore.store);delete defaults.obsSecret;delete defaults.__internal__;
 return{defaults,constants:{DefaultGamePlatforms:module.DefaultGamePlatforms,DEFAULT_PLAYERCOLORS:module.DEFAULT_PLAYERCOLORS}};
}
