import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/main/playerBans.ts'],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
});
const { checkPlayerBan, managePlayerBans } = await import(
	'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')
);
const localPython = ['.cache/ip-ban-python/Scripts/python.exe', '.cache/ip-ban-python/bin/python'].find(existsSync);
const python =
	process.env.TANUKI_AUTH_TEST_PYTHON ??
	(localPython ? resolve(localPython) : process.platform === 'win32' ? 'py' : 'python3');
const program = `
import json, os, sys, tempfile, threading
from pathlib import Path
from werkzeug.serving import make_server, WSGIRequestHandler
import auth
class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs): pass
with tempfile.TemporaryDirectory(prefix='tanuki-ip-ban-integration-') as folder:
    database = str(Path(folder) / 'auth.sqlite3')
    app = auth.create_app(database)
    auth.set_password(database, 'integration-admin', 'integration-test-only')
    server = make_server('127.0.0.1', 0, app, request_handler=QuietHandler)
    threading.Thread(target=lambda: (sys.stdin.readline(), server.shutdown()), daemon=True).start()
    print(json.dumps({'port': server.server_port}), flush=True)
    server.serve_forever()
    server.server_close()
`;
const child = spawn(python, [...(python === 'py' ? ['-3.12'] : []), '-u', '-c', program], {
	windowsHide: true,
	stdio: ['pipe', 'pipe', 'pipe'],
	env: { ...process.env, PYTHONPATH: resolve('server/debug-auth'), BAN_ADMIN_NAME: 'integration-admin' },
});
let errors = '';
child.stderr.on('data', (data) => {
	errors += data;
});
const lines = createInterface({ input: child.stdout });
const exited = once(child, 'exit');
const timeout = setTimeout(() => child.kill(), 20000);
try {
	const ready = await Promise.race([
		once(lines, 'line').then(([line]) => JSON.parse(line)),
		exited.then(() => {
			throw new Error('Test API failed to start: ' + errors);
		}),
	]);
	const base = `http://127.0.0.1:${ready.port}`;
	const throughProxy = (ip) => (url, options) =>
		fetch(base + new URL(url).pathname, {
			...options,
			headers: { ...options.headers, 'X-Real-IP': ip },
		});
	const admin = (payload) =>
		managePlayerBans({ password: 'integration-test-only', ...payload }, throughProxy('9.9.9.9'));
	const check = (uid, ip, roster = []) => checkPlayerBan(uid, uid, 'CODE#0', roster, throughProxy(ip));
	assert.equal(
		await check('first', '8.8.8.8', [{ playerUid: 'observed', playerName: 'Observed', publicIp: '1.1.1.1' }]),
		'clear'
	);
	const initial = await admin({ action: 'list' });
	assert.ok(!initial.error, `${initial.error}\n${errors}`);
	assert.equal(initial.ipBansAvailable, true);
	const self = initial.history.find((row) => row.display_name === 'first');
	assert.equal(self.public_ip, '8.8.8.8');
	assert.equal(
		initial.history.find((row) => row.display_name === 'Observed').public_ip,
		'',
		'A roster report must not assign the caller IP to another player'
	);
	const added = await admin({ action: 'add-history-ip', uidDigest: self.uid_digest, reason: 'integration test' });
	assert.equal(added.bans[0].ban_type, 'ip');
	assert.equal(added.bans[0].public_ip, '8.8.8.8');
	assert.equal(await check('changed-uid', '8.8.8.8'), 'banned');
	assert.equal(
		await check('first', '1.1.1.1'),
		'clear',
		'An IP-only ban must not become a UID ban after an address change'
	);
	const uidAdded = await admin({ action: 'add', playerUid: 'first', displayName: 'first' });
	assert.equal(uidAdded.bans.find((row) => row.ban_type === 'uid').public_ip, '1.1.1.1');
	assert.equal(
		uidAdded.bans.find((row) => row.ban_type === 'ip').public_ip,
		'8.8.8.8',
		'The IP ban target must stay pinned'
	);
	assert.equal(await check('first', '2606:4700:4700::1111'), 'banned');
	const removedIp = await admin({ action: 'remove-ip', publicIp: '8.8.8.8' });
	assert.equal(removedIp.bans.length, 1);
	assert.equal(removedIp.bans[0].ban_type, 'uid');
	assert.equal(await check('changed-uid', '8.8.8.8'), 'clear');
	await admin({ action: 'remove', uidDigest: self.uid_digest });
	assert.equal(await check('first', '2606:4700:4700::1111'), 'clear');
	console.log(
		'PASS real local API + production IPC transport: trusted self IP, unknown roster IP, typed lists, UID/IP independence, changed UID/IP, pinned target and independent removal'
	);
} finally {
	child.stdin.end('stop\n');
	await exited;
	clearTimeout(timeout);
	lines.close();
}
