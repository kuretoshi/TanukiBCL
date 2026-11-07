// Build-time visual assets from the existing Electron UI; no React is shipped.
import{createRequire}from'node:module';
import{readFile,writeFile}from'node:fs/promises';
import{resolve,join}from'node:path';
import ts from'typescript';
const root=resolve(import.meta.dirname,'..'),require=createRequire(join(root,'package.json'));
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const icons={};
for(const name of ['Settings','RefreshSharp','Close','Remove','Mic','MicOff','VolumeUp','VolumeOff','WifiOff','LinkOff','ErrorOutlineOutlined','Tune','GridView','Groups','Person','GraphicEq','Keyboard','Layers','Science','SystemUpdate','Videocam','ContactSupport','ArrowDropDown','ArrowBack']){
const Icon=require(`@mui/icons-material/${name}`).default;
icons[name]=renderToStaticMarkup(React.createElement(Icon)).replace(/<style[\s\S]*?<\/style>/g,'').replace(/ class="[^"]*"/g,'').replace(/ data-testid="[^"]*"/g,'');}
const source=ts.createSourceFile('Footer.tsx',await readFile(join(root,'src/renderer/components/Footer.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const svgs=[];function walk(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText()==='svg')svgs.push(n.getText());ts.forEachChild(n,walk);}walk(source);
for(const[index,name]of ['GitHub','Discord','Support','X'].entries())icons[name]=svgs[index].replace(/\{(\d+)\}/g,'"$1"').replace(/strokeWidth=/g,'stroke-width=').replace(/strokeLinecap=/g,'stroke-linecap=').replace(/strokeLinejoin=/g,'stroke-linejoin=');
icons.Radio=await readFile(join(root,'static/radio.svg'),'utf8');
await writeFile(join(root,'src-tauri/rust-ui/assets/icons.json'),JSON.stringify(icons));
let fonts='';for(const[name,path]of [['Varela','node_modules/typeface-varela/files/varela-latin-400.woff2'],['Source Code Pro','node_modules/source-code-pro/WOFF2/TTF/SourceCodePro-Regular.ttf.woff2']]){const bytes=await readFile(join(root,path));fonts+=`@font-face{font-family:"${name}";font-style:normal;font-weight:400;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');font-display:swap}\n`;}
await writeFile(join(root,'src-tauri/rust-ui/assets/fonts.css'),fonts);
console.log('Exported existing Electron SVG icons and two original fonts.');
