import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { readFileSync } from 'node:fs';

export const clientPeerSchema = JSON.parse(
	readFileSync(new URL('../src/common/clientPeerConfigSchema.json', import.meta.url), 'utf8')
);

// Ajv's runtime compiler uses new Function, which is blocked by Tauri's CSP.
// Generate the identical validator at build time instead of permitting eval.
export function compileClientPeerValidator() {
	const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: true } });
	addFormats(ajv);
	ajv.addSchema(clientPeerSchema, 'tanuki-peer');
	return (
		`import * as tauriFormats from 'ajv-formats/dist/formats';\n` +
		standaloneCode(ajv, { validateClientPeerConfig: 'tanuki-peer' }).replaceAll(
			'require("ajv-formats/dist/formats")',
			'tauriFormats'
		)
	);
}
