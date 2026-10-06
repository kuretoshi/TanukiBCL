import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'node:fs';

const debugAuthPath = resolve(__dirname, '.tools/debug-password.json');
const debugAuthUrl = (
	process.env.TANUKI_DEBUG_AUTH_URL ?? 'https://debug-auth.kuretoshi.work/v1/debug-auth/verify'
).trim();
if (debugAuthUrl) {
	const endpoint = new URL(debugAuthUrl);
	if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
		throw new Error('TANUKI_DEBUG_AUTH_URL must be an HTTPS URL without credentials, query, or fragment.');
}
const debugAuth =
	!debugAuthUrl && existsSync(debugAuthPath) ? readFileSync(debugAuthPath, 'utf8').replace(/^\uFEFF/, '') : '';

export default defineConfig({
	main: {
		define: {
			'process.env.TANUKI_DEBUG_AUTH': JSON.stringify(debugAuth),
			'process.env.TANUKI_DEBUG_AUTH_URL': JSON.stringify(debugAuthUrl),
		},
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				// Dev-only dependency: never bundled, and absent from packaged builds.
				external: ['electron-devtools-installer'],
				input: {
					index: resolve(__dirname, 'src/main/index.ts'),
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'src/preload/index.ts'),
				},
			},
		},
	},
	renderer: {
		resolve: {
			alias: {
				'@': resolve(__dirname, 'src'),
				path: 'path-browserify',
				buffer: 'buffer',
				process: 'process',
				events: 'events',
			},
		},
		define: {
			global: 'globalThis',
		},
		plugins: [react()],
	},
});
