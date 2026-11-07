import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyTauriBase(root = resolve(import.meta.dirname, '..')) {
	const base = JSON.parse(await readFile(join(root, 'src-tauri/release-base.json'), 'utf8'));
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
	if (pkg.version !== base.baseVersion || config.version !== base.betaVersion)
		throw new Error('Tauri version does not match the pinned public release.');
	for (const [path, expected] of Object.entries(base.files)) {
		const content = (await readFile(join(root, path), 'utf8')).replace(/\r\n/g, '\n');
		if (createHash('sha256').update(content).digest('hex') !== expected)
			throw new Error(`Tauri release base changed: ${path}. Review and rebase before building.`);
	}
	console.log(`Tauri base verified: ${base.tag} @ ${base.commit} (${Object.keys(base.files).length} core files).`);
	return base;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyTauriBase();
