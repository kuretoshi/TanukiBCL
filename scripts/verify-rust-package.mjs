import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const {version}=JSON.parse(await readFile(join(root,'src-tauri/tauri.conf.json'),'utf8'));
const portable=join(root,`dist-tauri/TanukiBCL-Tauri-Beta-${version}`);
const setup=join(root,`dist-tauri/TanukiBCL-Tauri-Beta-Setup-${version}.exe`);
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
async function files(dir){const rows=[];for(const f of await readdir(dir,{withFileTypes:true})){const p=join(dir,f.name);if(f.isDirectory())rows.push(...await files(p));else rows.push(p);}return rows;}
const inventory=await files(portable), paths=inventory.map(p=>relative(portable,p).replaceAll('\\','/'));
assert(!paths.some(p=>/(^|\/)(node_modules|node|tanuki-node|snr-reader|nos-reader|TbclSnapshotReader|TbclSnrReader)(\/|\.|$)/i.test(p)));
assert(!paths.some(p=>/\.(?:cs|csproj|deps\.json|runtimeconfig\.json|js|ts|tsx|wasm)$/i.test(p)),'Frontend must be embedded, not external legacy runtime files');
assert.deepEqual(paths.filter(p=>p.endsWith('.exe')).sort(),['TanukiBCL-Tauri-Beta.exe','backend/out/rust-clr/x64/tbcl-clr-reader.exe','backend/out/rust-clr/x86/tbcl-clr-reader.exe'].sort());
assert.equal(await sha(join(portable,'TanukiBCL-Tauri-Beta.exe')),await sha(join(root,'src-tauri/target/release/tanuki-bcl-tauri.exe')));
for(const [arch,target]of [['x64',''],['x86','i686-pc-windows-msvc/']])assert.equal(await sha(join(portable,`backend/out/rust-clr/${arch}/tbcl-clr-reader.exe`)),await sha(join(root,`src-tauri/target/${target}release/tbcl-clr-reader.exe`)));
const base=JSON.parse(await readFile(join(portable,'release-base.json'),'utf8'));
assert.equal(base.betaVersion,version);
const ui=await files(join(root,'out/tauri-rust-ui'));
assert(ui.some(p=>p.endsWith('.wasm')));
assert(!ui.some(p=>/speech|react|assets[/\\]index/.test(p)));
const html=await readFile(join(root,'out/tauri-rust-ui/index.html'),'utf8');
assert(html.includes('./rust-ui/bootstrap.js'));
const listing=execFileSync('C:/Program Files/7-Zip/7z.exe',['l','-slt',setup],{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
const archived=listing.split(/\r?\n/).filter(s=>s.startsWith('Path = ')).map(s=>s.slice(7).replaceAll('\\','/'));
assert.deepEqual(archived.filter(s=>s.startsWith('backend/')).sort(),paths.filter(s=>s.startsWith('backend/')).sort());
assert(archived.includes('tanuki-bcl-tauri.exe'));
const noticeFile=join(portable,'backend/THIRD-PARTY-RUST.txt');
const noticeBytes=(await stat(noticeFile)).size;
assert(noticeBytes<16*1024*1024,'Unexpectedly large dependency notices');
const notices=execFileSync('C:/Program Files/7-Zip/7z.exe',['e','-so',setup,'backend/THIRD-PARTY-RUST.txt'],{encoding:'utf8',windowsHide:true,maxBuffer:noticeBytes+65536});
assert.equal(notices,await readFile(noticeFile,'utf8'),'Installer and portable notices differ');
for(const asset of ['varela-OFL.txt','source-code-pro-OFL.txt','mui-icons-MIT.txt'])assert(notices.includes(asset),`Missing original UI license in installer: ${asset}`);
assert(!archived.some(p=>/node_modules|tanuki-node|TbclSnapshotReader|TbclSnrReader|\.deps\.json|\.runtimeconfig\.json/i.test(p)));
const installerSource=await readFile(join(root,'src-tauri/target/release/nsis/x64/installer.nsi'),'utf8');
assert(installerSource.includes('!define BUNDLEID "work.kuretoshi.tanukibcl.tauri.beta"'));
assert(installerSource.includes('!define INSTALLMODE "currentUser"'));
const option=(key,fallback)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:fallback;
const preservation=JSON.parse(await readFile(resolve(root,option('--preservation-manifest','.tools/rust-clr-probe/electron-preservation.json')),'utf8'));
let retained;
for(const directory of [root,preservation.root]){
 const candidate=join(directory,'dist-tauri/TanukiBCL-Tauri-Beta-3.2.62-tauri-beta.7/TanukiBCL-Tauri-Beta.exe');
 try{await stat(candidate);retained=candidate;break;}catch(error){if(error.code!=='ENOENT')throw error;}
}
assert(retained,'The previously delivered beta7 must remain in an existing distribution directory');
assert.equal(await sha(retained),'5a87ff2254666bd881dee95f8ae066e1b1172924d29a66d872df4e90b553af9a');
const retained8=join(root,'dist-tauri/TanukiBCL-Tauri-Beta-3.2.62-tauri-beta.8/TanukiBCL-Tauri-Beta.exe');
assert.equal(await sha(retained8),'7458af127748a6dc72befdc14704f16b011aacde6a0f9239d246000d5cc51306');
let checked=0;
for(const [p,hash]of Object.entries(preservation.files)){let actual=null;try{actual=await sha(join(preservation.root,p));}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(actual,hash,`Electron file changed: ${p}`);checked++;}
for(const [p,hash]of Object.entries(preservation.tauriArtifacts??{}))assert.equal(await sha(join(root,p)),hash,`Retained Tauri artifact changed: ${p}`);
for(const path of ['release-base.json','backend/release-base.json'])assert.deepEqual(JSON.parse(await readFile(join(portable,path),'utf8')),JSON.parse(await readFile(join(root,'src-tauri/release-base.json'),'utf8')));
const report={passed:true,date:new Date().toISOString(),version,executableSha256:await sha(join(portable,'TanukiBCL-Tauri-Beta.exe')),installerSha256:await sha(setup),installerBytes:(await stat(setup)).size,portableFileCount:paths.length,portableTotalBytes:(await Promise.all(inventory.map(p=>stat(p)))).reduce((a,s)=>a+s.size,0),runtime:'Rust native host + Rust/WASM UI + generated wasm-bindgen bridge + WebView2',nodeRuntime:false,managedApplicationHelper:false,reactRuntime:false,installerInventoryMatched:true,separateIdentifier:'work.kuretoshi.tanukibcl.tauri.beta',retainedBeta7:true,electronTrackedFilesUnchanged:checked,frontendFiles:ui.map(p=>relative(join(root,'out/tauri-rust-ui'),p).replaceAll('\\','/')),files:paths};
await writeFile(resolve(root,option('--report',`docs/validation-rust-package-${version.split('-')[0]}.json`)),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,files:undefined}));
