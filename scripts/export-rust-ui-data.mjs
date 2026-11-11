// Read-only build-time extraction of the pinned release's labels and defaults.
// The generated data contains no JavaScript application logic.
import ts from 'typescript';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {releaseData} from './tauri-release-data.mjs';
const root=path.resolve(import.meta.dirname,'..'),folder=path.join(root,'src/renderer/settings/sections');
const categories={GeneralSection:'general',AppLayoutSection:'appLayout',LobbySection:'lobby',PlayersSection:'players',AudioSection:'audio',VoiceEffectsSection:'voiceEffects',KeybindsSection:'keybinds',OverlaySection:'overlay',AdvancedSection:'advanced',StreamingSection:'streaming',UpdateSection:'update',TohGhostRoleSettings:'lobby'};
const schema=new Map();
function walk(node,visit){visit(node);ts.forEachChild(node,child=>walk(child,visit));}
function translations(node){const keys=[];if(node)walk(node,n=>{if(ts.isCallExpression(n)&&n.expression.getText()==='t'&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))keys.push(n.arguments[0].text);});return keys;}
for(const file of await readdir(folder)){
 if(!file.endsWith('.tsx'))continue;const source=ts.createSourceFile(file,await readFile(path.join(folder,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const category=categories[path.basename(file,'.tsx')];
 walk(source,node=>{
   if(ts.isObjectLiteralExpression(node)){
     const attr=name=>node.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText()===name)?.initializer;
     const key=attr('key'),label=attr('label');
     if(key&&ts.isStringLiteralLike(key)&&label&&category==='lobby'){const labels=translations(label);if(labels.length)schema.set(`myLobbySettings.${key.text}`,{key:`myLobbySettings.${key.text}`,category,label:labels[0],kind:'SwitchRow',source:file});}
   }
   if(!ts.isJsxElement(node)&&!ts.isJsxSelfClosingElement(node))return;
   const opening=ts.isJsxElement(node)?node.openingElement:node,tag=opening.tagName.getText();if(!['SwitchRow','SliderRow','SelectRow','SettingRow'].includes(tag))return;
   const attr=name=>opening.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText()===name)?.initializer;
   const labels=translations(attr('label'));if(!labels.length)return;
   const value=(attr('checked')??attr('value'))?.getText()??'';
   let key=value.match(/settings\.([\w.]+)/)?.[1]??(value.match(/values\.(\w+)/)?.[1]&&`myLobbySettings.${value.match(/values\.(\w+)/)[1]}`);
   if(!key)walk(node,n=>{if(!key&&ts.isCallExpression(n)&&n.expression.getText()==='setSettings'&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))key=n.arguments[0].text;});
   if(!key||key==='voiceEffectTunings')return;
   const numeric=name=>{const raw=attr(name)?.getText()?.replace(/[{}]/g,'');return raw&&Number.isFinite(Number(raw))?Number(raw):undefined;};
   schema.set(key,{key,category,label:labels[0],kind:tag,description:translations(attr('description'))[0],min:numeric('min'),max:numeric('max'),step:numeric('step'),source:file});
 });
}
const locales={};for(const language of await readdir(path.join(root,'static/locales'))){try{locales[language]=JSON.parse(await readFile(path.join(root,'static/locales',language,'translation.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
const {defaults,constants}=await releaseData(root);
const languageSource=ts.createSourceFile('languages.ts',await readFile(path.join(root,'src/renderer/language/languages.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const languages={};walk(languageSource,node=>{if(ts.isVariableDeclaration(node)&&node.name.getText()==='languages'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)){for(const item of node.initializer.properties){if(ts.isPropertyAssignment(item)&&ts.isObjectLiteralExpression(item.initializer)){const name=item.initializer.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText()==='name')?.initializer;if(name&&ts.isStringLiteralLike(name))languages[item.name.getText().replace(/['"]/g,'')]=name.text;}}}});
const output=path.join(root,'src-tauri/rust-ui/assets');await mkdir(output,{recursive:true});
const modLabels={};
const modsSource=ts.createSourceFile('Mods.ts',await readFile(path.join(root,'src/common/Mods.ts'),'utf8'),ts.ScriptTarget.Latest,true);
walk(modsSource,node=>{if(ts.isVariableDeclaration(node)&&node.name.getText()==='modList'&&node.initializer&&ts.isArrayLiteralExpression(node.initializer)){for(const item of node.initializer.elements){if(!ts.isObjectLiteralExpression(item))continue;const attr=name=>item.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText()===name)?.initializer;const id=attr('id'),label=attr('label');if(id&&label&&ts.isStringLiteralLike(id)&&ts.isStringLiteralLike(label))modLabels[id.text]=label.text;}}});
await writeFile(path.join(output,'release-data.json'),JSON.stringify({defaults,constants,languages,languageOrder:Object.keys(languages),modLabels,locales,settings:[...schema.values()]},null,2)+'\n');
const missing=[];for(const [key,value]of Object.entries(defaults)){if(key==='myLobbySettings'){for(const child of Object.keys(value))if(!schema.has(`${key}.${child}`))missing.push(`${key}.${child}`);}else if(!schema.has(key))missing.push(key);}
console.log(JSON.stringify({settings:schema.size,languages:Object.keys(locales).length,missing}));
