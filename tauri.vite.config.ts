import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { compileClientPeerValidator } from './scripts/tauri-validator.mjs';

export default defineConfig({
	root: 'src/renderer',
	base: './',
	plugins: [
		{
			name: 'tauri-runtime',
			enforce: 'pre',
			load(id) {
				if (id.replace(/\\/g, '/').endsWith('/src/renderer/voice/useVoiceController.ts'))
					return `export {voiceController,useVoiceSnapshot,useVoiceEngine} from '../../tauri/use-voice-controller';`;
				if (id.replace(/\\/g, '/').endsWith('/src/renderer/lib/validateClientPeerConfig.ts'))
					return compileClientPeerValidator();
			},
			resolveId(source, importer) {
				if (importer?.replace(/\\/g, '/').includes('/src/renderer/') && /(?:^|\/)useVoiceController(?:\.ts)?$/.test(source))
					return resolve('src/tauri/use-voice-controller.ts');
				if (importer?.replace(/\\/g, '/').includes('/src/renderer/') && /(?:^|\/)electron-bridge$/.test(source))
					return resolve('src/tauri/renderer-bridge.ts');
			},
			transform(code, id) {
				if (!id.replace(/\\/g, '/').includes('/src/renderer/')) return;
				return code
					.replaceAll('app://bundle/', 'https://tauri.localhost/')
					.replace(/(nos-cosmetic|snr-cosmetic|static|generate):\/\//g, 'https://$1.localhost/');
			},
		},
		react(),
	],
	resolve: { alias: { '@': resolve('src'), path: 'path-browserify', events: 'events', process: 'process' } },
	define: { global: 'globalThis' },
	server: { port: 1420, strictPort: true, host: 'localhost' },
	build: {
		outDir: '../../out/tauri-renderer',
		emptyOutDir: true,
		rollupOptions: {
			input: { app: resolve('src/renderer/index.html'), nativeVoice: resolve('src/renderer/native-voice.html') },
		},
	},
});
