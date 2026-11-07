import {defineConfig} from 'vite';
export default defineConfig({root:'.',publicDir:false,build:{outDir:'out/tauri-rust-ui'},preview:{host:'localhost',port:1420,strictPort:true}});
