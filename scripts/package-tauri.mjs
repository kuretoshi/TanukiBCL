import { cp, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeRustNotices } from './tauri-rust-notices.mjs';
import {rustResourcePaths} from './tauri-rust-resources.mjs';

const root = resolve(import.meta.dirname, '..');
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'src-tauri/target');
const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const distribution = join(root, 'dist-tauri');
const portable = join(distribution, `TanukiBCL-Tauri-Beta-${version}`);
const migration=JSON.parse(await readFile(join(root,'docs/rust-migration-status.json'),'utf8'));
if(migration.deliveredVersion===version){
	for(const path of [join(portable,'TanukiBCL-Tauri-Beta.exe'),join(distribution,`TanukiBCL-Tauri-Beta-Setup-${version}.exe`)]){
		try{await access(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
		throw new Error('Preserve the delivered build. Bump the Tauri beta version before packaging a new migration.');
	}
}
await mkdir(portable, { recursive: true });
await cp(join(target, 'release/tanuki-bcl-tauri.exe'), join(portable, 'TanukiBCL-Tauri-Beta.exe'));
for(const name of rustResourcePaths){await mkdir(join(portable,'backend',name,'..'),{recursive:true});await cp(join(root,'out/tauri-backend',name),join(portable,'backend',name),{recursive:true});}
await cp(join(root, 'docs/tauri-beta.md'), join(portable, 'README.txt'));
await cp(join(root, 'src-tauri/release-base.json'), join(portable, 'release-base.json'));
await writeRustNotices(root, join(portable, 'THIRD-PARTY-RUST.txt'));
await writeFile(
	join(portable, 'Start-Native-Voice.cmd'),
	'@echo off\r\nstart "" "%~dp0TanukiBCL-Tauri-Beta.exe" --native-voice\r\n'
);
await writeFile(
	join(portable, 'Start-Native-Voice-Background.cmd'),
	'@echo off\r\nstart "" "%~dp0TanukiBCL-Tauri-Beta.exe" --native-voice --headless\r\n'
);
if (process.argv.includes('--portable-only')) {
	const executable = join(portable, 'TanukiBCL-Tauri-Beta.exe');
	const hash = createHash('sha256')
		.update(await readFile(executable))
		.digest('hex');
	await writeFile(join(portable, 'TanukiBCL-Tauri-Beta.exe.sha256'), `${hash}  TanukiBCL-Tauri-Beta.exe\n`);
	console.log(`Run without installing: ${executable}`);
	process.exit(0);
}
const installers = join(target, 'release/bundle/nsis');
const installer = (await readdir(installers)).find((file) => file.includes(`_${version}_x64-setup.exe`));
if (!installer) throw new Error('Tauri installer was not generated.');
const setupName = `TanukiBCL-Tauri-Beta-Setup-${version}.exe`;
const setup = join(distribution, setupName);
await cp(join(installers, installer), setup);
const hash = createHash('sha256')
	.update(await readFile(setup))
	.digest('hex');
await writeFile(join(distribution, `${setupName}.sha256`), `${hash}  ${setupName}\n`);
console.log(`Installer: ${setup}`);
console.log(`Run without installing: ${join(portable, 'TanukiBCL-Tauri-Beta.exe')}`);
