import {resolve,join} from 'node:path';
import {verifyTauriBase} from './verify-tauri-base.mjs';
import {prepareRustResources} from './tauri-rust-resources.mjs';
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Tauri beta targets Windows x64.');
const root=resolve(import.meta.dirname,'..');
await verifyTauriBase(root);
await prepareRustResources(join(root,'out/tauri-backend'));
console.log('Prepared Rust runtime resources; no Node backend or managed app helper is required.');
