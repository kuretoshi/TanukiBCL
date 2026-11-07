import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

export async function writeRustNotices(root, destination) {
	const metadata = JSON.parse(
		execFileSync(
			'cargo',
			['metadata', '--manifest-path', join(root, 'src-tauri/Cargo.toml'), '--locked', '--format-version', '1'],
			{ cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }
		)
	);
	const notices = ['Rust dependency notices for the Tauri beta. Includes platform and build dependencies.\n'];
	notices.push(await readFile(join(root, 'src-tauri/licenses/path-intersection.txt'), 'utf8'));
	for (const file of ['unity-sprite-LICENSE', 'unity-sprite-LICENSE-APACHE', 'unity-sprite-NOTICE']) {
		notices.push(`\n--- ${file} ---\n${await readFile(join(root, 'src-tauri/licenses', file), 'utf8')}\n`);
	}
	for (const file of ['varela-OFL.txt', 'source-code-pro-OFL.txt', 'mui-icons-MIT.txt']) {
		notices.push(`\n--- Embedded original UI asset: ${file} ---\n${await readFile(join(root, 'src-tauri/licenses', file), 'utf8')}\n`);
	}
	for (const pkg of metadata.packages.filter((pkg) => pkg.source).sort((a, b) => a.name.localeCompare(b.name))) {
		const directory = dirname(pkg.manifest_path);
		const files = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && /^(license|copying|notice)([._-]|$)/i.test(entry.name))
			.map((entry) => entry.name);
		if (pkg.license_file) {
			const path = resolve(directory, pkg.license_file);
			const within = relative(directory, path);
			if (!within.startsWith('..') && !isAbsolute(within) && !files.includes(within)) files.push(within);
		}
		if (pkg.name === 'opusic-sys') files.push('opus/COPYING');
		notices.push(
			`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'See included license'}\n${pkg.repository ?? ''}\n`
		);
		for (const file of files) {
			const text = await readFile(join(directory, file), 'utf8');
			notices.push(`\n--- ${file} ---\n${text}\n`);
		}
		// sonora-aec3 0.2.0 omits the workspace LICENSE in its crate archive.
		// The identically versioned pipeline crate carries that shared license.
		if (pkg.name === 'sonora-aec3' && files.length === 0) {
			const pipeline = metadata.packages.find((entry) => entry.name === 'sonora' && entry.version === pkg.version);
			if (!pipeline) throw new Error('Missing Sonora workspace license source');
			const license = await readFile(join(dirname(pipeline.manifest_path), 'LICENSE'), 'utf8');
			notices.push(`\n--- Sonora workspace LICENSE (from sonora ${pipeline.version}) ---\n${license}\n`);
		}
	}
	await writeFile(destination, notices.join(''), 'utf8');
}
