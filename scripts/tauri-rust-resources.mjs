import {cp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {releaseData} from './tauri-release-data.mjs';
import {prepareVoiceMaps} from './tauri-voice-maps.mjs';
import {prepareVoiceEffects} from './tauri-voice-effects.mjs';
import {prepareNativeSpeech} from './tauri-native-speech.mjs';
import {writeRustNotices} from './tauri-rust-notices.mjs';
export const rustResourcePaths=['rust-default-settings.json','rust-constants.json','rust-assets','rust-speech','out/rust-clr','LICENSE','release-base.json','THIRD-PARTY-RUST.txt'];
export async function prepareRustResources(output){
 const root=resolve(import.meta.dirname,'..');
 await mkdir(output,{recursive:true});
 await prepareVoiceMaps();await prepareVoiceEffects();await prepareNativeSpeech(output);
 const {defaults,constants}=await releaseData(root);
 await writeFile(join(output,'rust-default-settings.json'),JSON.stringify(defaults,null,2)+'\n');
 await writeFile(join(output,'rust-constants.json'),JSON.stringify(constants,null,2)+'\n');
 await mkdir(join(output,'rust-assets'),{recursive:true});
 for(const name of ['player','ghost'])await cp(join(root,'static/images/generate',name+'.png'),join(output,'rust-assets',name+'.png'));
 await cp(join(root,'LICENSE'),join(output,'LICENSE'));
 await cp(join(root,'src-tauri/release-base.json'),join(output,'release-base.json'));
 await writeRustNotices(root,join(output,'THIRD-PARTY-RUST.txt'));
}
