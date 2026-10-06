import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tbcl-debug-auth-'));
try {
	const output = join(directory, 'debugAuth.mjs');
	const built = await build({
		entryPoints: ['src/main/debugAuth.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	});
	await writeFile(output, built.outputFiles[0].contents);
	const { verifyDebugPassword, MAX_DEBUG_PASSWORDS } = await import(pathToFileURL(output));
	const record = (password, salt = '0123456789abcdef0123456789abcdef') => ({
		salt,
		hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'),
	});
	const original = record('test-original');
	const extra = record('test-extra', 'fedcba9876543210fedcba9876543210');
	const config = JSON.stringify({ passwords: [original, extra] });
	assert.equal(verifyDebugPassword('test-original', JSON.stringify(original)), true);
	assert.equal(verifyDebugPassword('test-original', config), true);
	assert.equal(verifyDebugPassword('test-extra', config), true);
	for (const password of ['', 'incorrect', null, {}, 'x'.repeat(1025)])
		assert.equal(verifyDebugPassword(password, config), false);
	for (const bad of [
		'invalid',
		'{}',
		'null',
		JSON.stringify({ passwords: [] }),
		JSON.stringify({ passwords: null, ...original }),
		JSON.stringify({ passwords: [original, {}] }),
		JSON.stringify({ passwords: Array(MAX_DEBUG_PASSWORDS + 1).fill(original) }),
	]) {
		assert.equal(verifyDebugPassword('test-original', bad), false);
	}

	if (process.platform === 'win32') {
		const configPath = join(directory, 'debug-password.json');
		const script = resolve('scripts/set-debug-password.ps1');
		const runner = join(directory, 'run.ps1');
		const quote = (value) => `'${value.replaceAll("'", "''")}'`;
		async function add(name, first, second = first) {
			await writeFile(
				runner,
				`\uFEFF$ErrorActionPreference = 'Stop'\n$global:debugTestAnswers = [Collections.Generic.Queue[string]]::new()\n$global:debugTestAnswers.Enqueue(${quote(first)})\n$global:debugTestAnswers.Enqueue(${quote(second)})\nfunction Read-Host { param($Prompt, [switch]$AsSecureString) ConvertTo-SecureString $global:debugTestAnswers.Dequeue() -AsPlainText -Force }\n& ${quote(script)} -Add -Name ${quote(name)} -ConfigurationPath ${quote(configPath)}\n`
			);
			execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner], {
				windowsHide: true,
				stdio: 'pipe',
				env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
			});
		}
		await writeFile(configPath, JSON.stringify(original));
		await add('tester-one', 'test-one');
		await add('tester-two', 'test-two');
		await add('日本語担当者', '確認者テスト🔑');
		const saved = await readFile(configPath, 'utf8');
		const parsed = JSON.parse(saved);
		assert.equal(parsed.passwords.length, 4);
		assert.deepEqual(parsed.passwords[0], { name: 'developer', ...original });
		for (const password of ['test-original', 'test-one', 'test-two', '確認者テスト🔑'])
			assert.equal(verifyDebugPassword(password, saved), true);
		assert.equal(saved.includes('test-one'), false, 'Do not save plaintext passwords');
		await assert.rejects(add('tester-one', 'another-password'));
		assert.equal(await readFile(configPath, 'utf8'), saved, 'Duplicate names must not overwrite credentials');
		await assert.rejects(add('tester-three', 'first-password', 'different-password'));
		assert.equal(await readFile(configPath, 'utf8'), saved, 'Mismatched passwords must not overwrite credentials');
		await writeFile(configPath, '{');
		await assert.rejects(add('tester-three', 'test-three'));
		assert.equal(await readFile(configPath, 'utf8'), '{', 'Do not overwrite malformed configuration');
	}
	console.log(
		'PASS debug authentication: legacy and multiple passwords, invalid input, additive setup, no plaintext, failed additions preserve configuration'
	);
} finally {
	assert.equal(
		resolve(directory).startsWith(resolve(tmpdir()) + '\\tbcl-debug-auth-') ||
			resolve(directory).startsWith(resolve(tmpdir()) + '/tbcl-debug-auth-'),
		true
	);
	await rm(directory, { recursive: true, force: true });
}
