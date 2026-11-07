// Local transport tests for native Vanilla voice rules and integrations.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { startFixture, gameState } from './native-voice/fixture-server.mjs';
const root = resolve(import.meta.dirname, '..');
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/debug/tanuki-bcl-tauri.exe'));
const directory = join(root, '.tools/native-voice-features', `run-${Date.now()}`);
await mkdir(directory, { recursive: true });
const duration = 14;
const base = (client) => ({
	serverUrl: '',
	game: { ...gameState(client), map: 2, currentCamera: 7, closedDoors: [], lightRadius: 2, maxPlayers: 15 },
	frequency: 180,
	readyBeforeTimeline: true,
	lobbySettings: { maxDistance: 5.32 },
});
const owned = new Set();
function launch(config, output) {
	const child = spawn(
		executable,
		[
			'--native-voice-probe',
			'--voice-test-config',
			config,
			'--voice-test-output',
			output,
			'--voice-test-seconds',
			String(duration),
		],
		{ cwd: dirname(executable), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
	);
	owned.add(child);
	let log = '';
	child.stderr.on('data', (data) => (log = (log + data).slice(-5000)));
	child.finished = new Promise((done, fail) => {
		child.once('error', fail);
		child.once('exit', (code) => {
			owned.delete(child);
			code === 0 ? done() : fail(new Error(log || `Exit ${code}`));
		});
	});
	child.finished.catch(() => {});
	return child;
}
const scenarios = [
	[
		'nos-dying-recording',
		(a, b) => {
			const start = Date.now() + 4000;
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.nosAddonIds = ['tanuki.bcl.roles'];
				c.game.players[1].x = 20;
				c.game.players[1].isDead = true;
				const game = {
					...structuredClone(c.game),
					nosDyingVoices: [{ playerId: 1, started: start, seconds: 1, range: 2, x: 0, y: 0, loop: true }],
				};
				c.steps = [
					{ second: 4, game },
					{ second: 10, game: { ...game, nosDyingVoices: [] } },
				];
			}
		},
		(a) => {
			assert.equal(at(a, 3).outputEnergy, 0);
			assert.ok(at(a, 9).outputEnergy > at(a, 6).outputEnergy + 1000);
			assert.equal(at(a, 13).outputEnergy, at(a, 11).outputEnergy);
		},
	],
	[
		'nos-megaphone-recording',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.nosAddonIds = ['tanuki.bcl.roles'];
				c.game.players[1].x = 20;
				const charging = {
					...structuredClone(c.game),
					nosMegaphones: [{ playerId: 1, shotId: 1, phase: 'charging', energy: 0.5, range: 2, voiceEffect: false }],
				};
				const firing = {
					...structuredClone(charging),
					nosMegaphones: [{ ...charging.nosMegaphones[0], phase: 'firing' }],
				};
				c.steps = [
					{ second: 2, game: charging },
					{ second: 6, game: firing },
					{ second: 7, game: { ...firing, nosMegaphones: [] } },
				];
			}
		},
		(a) => {
			assert.equal(at(a, 5).outputEnergy, 0);
			assert.ok(at(a, 9).outputEnergy > 10000);
			assert.equal(at(a, 13).outputEnergy, at(a, 12).outputEnergy);
		},
	],
	[
		'nos-interview-recording',
		(a, b) => {
			const start = Date.now() + 2000;
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.nosAddonIds = ['tanuki.bcl.roles'];
				c.lobbySettings.deadOnly = true;
				const recording = {
					...structuredClone(c.game),
					nosInterviews: [{ playerId: 0, started: start, seconds: 3, stopped: 0, visible: [1], playStarted: 0 }],
				};
				const stopped = {
					...structuredClone(recording),
					nosInterviews: [{ ...recording.nosInterviews[0], stopped: start + 3000 }],
				};
				const playing = {
					...structuredClone(stopped),
					gameState: 2,
					nosInterviews: [{ ...stopped.nosInterviews[0], playStarted: start + 4000 }],
				};
				c.steps = [
					{ second: 2, game: recording },
					{ second: 5, game: stopped },
					{ second: 6, game: playing },
				];
			}
		},
		(a) => {
			assert.equal(at(a, 5).outputEnergy, 0);
			assert.ok(at(a, 9).outputEnergy > 10000);
			assert.equal(at(a, 13).outputEnergy, at(a, 11).outputEnergy);
		},
	],
	[
		'nos-bibiri-tail',
		(a, b) => {
			const event = Date.now() + 6000;
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.nosAddonIds = ['tanuki.bcl.roles'];
				const dead = structuredClone(c.game);
				dead.players[1].isDead = true;
				dead.nosBibiriEchoes = [{ playerId: 1, unixMs: event }];
				c.steps = [{ second: 6, game: dead }];
			}
		},
		(a) => {
			assert.ok(at(a, 8).outputEnergy > at(a, 7).outputEnergy);
			assert.equal(at(a, 13).outputEnergy, at(a, 11).outputEnergy);
		},
	],
	[
		'nos-jackal-radio-mask',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.players[1].x = 20;
				c.lobbySettings.jackalRadioEnabled = true;
				c.game.nosRadios = [{ kind: 1, hearableMask: 3, nameLength: 0, name: '' }];
			}
			b.steps = [
				{ second: 2, jackalRadio: true },
				{ second: 8, jackalRadio: false },
			];
		},
		(a, b) => {
			assert.equal(at(a, 1).outputEnergy, 0);
			assert.ok(at(a, 7).outputEnergy > at(a, 4).outputEnergy + 1000);
			assert.equal(at(a, 13).outputEnergy, at(a, 10).outputEnergy);
			assert.ok(a.status.voiceSnapshot.nosRadiosByPlayer['1']);
			assert.equal(b.status.radioActive, false);
		},
	],
	[
		'nos-jackal-mask-denies-listener',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.mod = 'NoS';
				c.game.players[1].x = 20;
				c.lobbySettings.jackalRadioEnabled = true;
				c.game.nosRadios = [{ kind: 1, hearableMask: 2, nameLength: 0, name: '' }];
			}
			b.steps = [
				{ second: 2, jackalRadio: true },
				{ second: 8, jackalRadio: false },
			];
		},
		(a) => {
			assert.equal(a.metrics.outputEnergy, 0);
			assert.ok(a.progress.find((p) => p.second === 6).radioClients.includes(2));
		},
	],
	[
		'snr-jackal-radio',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.mod = 'SUPER_NEW_ROLES';
				c.game.players[1].x = 20;
				c.game.players.forEach(
					(p) => (p.snrRole = { role: { value: 1, name: 'Jackal' }, modifier: null, ghostRole: null })
				);
				c.lobbySettings.jackalRadioEnabled = true;
			}
			b.steps = [
				{ second: 2, radio: true },
				{ second: 8, radio: false },
			];
		},
		(a) => {
			assert.equal(at(a, 1).outputEnergy, 0);
			assert.ok(at(a, 7).outputEnergy > at(a, 4).outputEnergy + 1000);
			assert.equal(at(a, 13).outputEnergy, at(a, 10).outputEnergy);
		},
	],
	[
		'toh-host-role-transfer',
		(a, b) => {
			a.game.mod = 'TOH4E';
			a.game.players[0].isImpostor = true;
			a.game.players[0].vanillaIsImpostor = true;
			a.game.players[0].tohRole = {
				roleId: 1,
				roleName: 'Impostor',
				customRoleType: 'Impostor',
				isKiller: true,
				isNeutralKiller: false,
			};
			a.game.players[1].tohRole = {
				roleId: 2,
				roleName: 'Crewmate',
				customRoleType: 'Crewmate',
				isKiller: false,
				isNeutralKiller: false,
			};
			a.game.tohRoleCatalog = [
				{ roleId: 1, roleName: 'Impostor', displayName: 'Impostor', customRoleType: 'Impostor', isKiller: true },
				{ roleId: 2, roleName: 'Crewmate', displayName: 'Crewmate', customRoleType: 'Crewmate', isKiller: false },
			];
		},
		(a, b) => {
			assert.equal(b.status.effectiveGame.mod, 'TOH4E');
			assert.equal(b.status.effectiveGame.players[1].tohRole.roleName, 'Crewmate');
			assert.equal(b.status.voiceSnapshot.tohRoleCatalog.length, 2);
			assert.ok(a.metrics.outputEnergy > 10000 && b.metrics.outputEnergy > 10000);
		},
	],
	[
		'camera',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.players[0].x = 0;
				c.game.players[0].y = 20;
				c.game.players[1].x = 29;
				c.game.players[1].y = -15.7;
				c.game.currentCamera = 0;
				c.lobbySettings.hearThroughCameras = true;
			}
		},
		(a, b) => {
			assert.ok(a.metrics.outputEnergy > 10000);
			assert.equal(b.metrics.outputEnergy, 0);
		},
	],
	[
		'haunting-role-change',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.players[1].isDead = true;
				c.lobbySettings.haunting = true;
			}
			const impostor = structuredClone(a.game);
			impostor.players[0].isImpostor = true;
			a.steps = [
				{ second: 4, game: impostor },
				{ second: 9, game: a.game },
			];
		},
		(a) => {
			assert.equal(at(a, 3).outputEnergy, 0);
			assert.ok(at(a, 8).outputEnergy > at(a, 5).outputEnergy + 500);
			assert.equal(at(a, 13).outputEnergy, at(a, 11).outputEnergy);
		},
	],
	[
		'radio-press-release',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.players.forEach((p) => (p.isImpostor = true));
				c.game.players[1].x = 20;
				c.lobbySettings.impostorRadioEnabled = true;
			}
			b.steps = [
				{ second: 2, radio: true },
				{ second: 8, radio: false },
			];
		},
		(a) => {
			assert.equal(at(a, 1).outputEnergy, 0);
			assert.ok(at(a, 7).outputEnergy > at(a, 4).outputEnergy + 1000);
			assert.equal(at(a, 13).outputEnergy, at(a, 10).outputEnergy);
			assert.ok(a.progress.find((p) => p.second === 6).radioClients.includes(2));
			assert.deepEqual(a.progress.at(-1).radioClients, []);
		},
	],
	[
		'radio-only-crew-privacy',
		(a, b) => {
			for (const c of [a, b]) {
				c.game.players[1].isImpostor = true;
				c.lobbySettings.impostorRadioOnlyMode = true;
			}
			b.steps = [
				{ second: 2, radio: true },
				{ second: 8, radio: false },
			];
		},
		(a, b) => {
			assert.equal(a.metrics.outputEnergy, 0);
			assert.equal(b.metrics.outputEnergy, 0);
		},
	],
	[
		'microphone-gate',
		(a, b) => {
			b.sharedSettings = { micSensitivityEnabled: true, micSensitivity: 1 };
		},
		(a, b) => {
			assert.equal(a.metrics.outputEnergy, 0);
			assert.ok(b.metrics.outputEnergy > 10000);
		},
	],
	[
		'leave-rejoin',
		(a) => {
			a.steps = [
				{ second: 5, game: { ...a.game, gameState: 3, lobbyCode: 'MENU', players: [] } },
				{ second: 9, game: a.game },
			];
		},
		(a, b, server) => {
			assert.equal(at(a, 8).sentPackets, at(a, 6).sentPackets);
			assert.ok(at(a, 13).sentPackets > at(a, 11).sentPackets + 30);
			assert.ok(server.counters.joins >= 3);
		},
	],
	[
		'obs-mobile-public-lobby',
		(a) => {
			a.sharedSettings = { mobileHost: true, obsOverlay: true, obsSecret: 'LOCALTEST' };
			a.lobbySettings = {
				maxDistance: 5.32,
				publicLobby_on: true,
				publicLobby_title: 'Local fixture',
				publicLobby_language: 'ja',
			};
			a.context = { gameInfo: { appVersion: '3.2.62', broadcastVersion: 7489, offsetsVersion: 1, mod: 'NONE' } };
		},
		(a, b, server) => {
			const f = server.features;
			for (const key of ['mobileBeacons', 'mobileFrames', 'obsFrames', 'publicLobbies', 'gameInfo', 'vadEvents'])
				assert.ok(f[key] > 0, JSON.stringify(f));
			assert.equal(f.publicEnabled, true);
			assert.equal(f.obsHasPrivateFields, false);
			assert.equal(f.mobileLobbyMatches, true);
			assert.equal(f.appVersion, '3.2.62');
		},
	],
];
function at(result, second) {
	const row = result.progress.find((p) => p.second === second);
	assert.ok(row, `Missing second ${second}`);
	return row.metrics;
}
const results = [];
try {
	for (const [name, prepare, validate] of scenarios.filter(
		([name]) => !process.argv.includes('--mods-only') || /^(nos-|snr-|toh-)/.test(name)
	)) {
		const server = await startFixture({ simulateMobile: true });
		try {
			const configs = [base(1), base(2)];
			const timestampEpoch = Date.now();
			prepare(...configs);
			const pending = [];
			for (const [c, config] of configs.entries()) {
				config.serverUrl = server.url;
				config.timestampEpoch = timestampEpoch;
				const file = join(directory, `${name}-${c}.json`),
					output = join(directory, `${name}-${c}-result.json`);
				await writeFile(file, JSON.stringify(config));
				pending.push({ output, child: launch(file, output) });
			}
			const timeout = setTimeout(
				() => {
					for (const child of owned) child.kill();
				},
				(duration + 30) * 1000
			);
			try {
				await Promise.all(pending.map((p) => p.child.finished));
			} finally {
				clearTimeout(timeout);
			}
			const [a, b] = await Promise.all(pending.map(async (p) => JSON.parse(await readFile(p.output, 'utf8'))));
			for (const r of [a, b]) {
				assert.equal(r.status.error, '', JSON.stringify({ name, status: r.status }));
				assert.ok(
					r.metrics.sentPackets > 100 && r.metrics.receivedPackets > 100,
					JSON.stringify({ name, metrics: r.metrics })
				);
				assert.ok(r.metrics.decodedFrames > 48000);
			}
			validate(a, b, server);
			results.push({
				name,
				passed: true,
				seconds: duration,
				main: a.metrics,
				peer: b.metrics,
				features: server.features,
				signaling: server.counters,
			});
			await writeFile(join(directory, 'partial-result.json'), JSON.stringify(results, null, 2));
			console.log(
				JSON.stringify({
					event: 'passed',
					name,
					mainEnergy: a.metrics.outputEnergy,
					peerEnergy: b.metrics.outputEnergy,
				})
			);
		} finally {
			for (const child of owned) child.kill();
			await Promise.allSettled([...owned].map((c) => c.finished));
			await server.close();
		}
	}
	await writeFile(
		join(directory, 'result.json'),
		JSON.stringify(
			{
				passed: true,
				executableSha256: createHash('sha256')
					.update(await readFile(executable))
					.digest('hex'),
				method: 'Generated tones and injected game states; loopback only; no devices or user profile writes',
				cases: results,
			},
			null,
			2
		) + '\n'
	);
	console.log(JSON.stringify({ passed: true, directory, scenarios: results.length }));
} finally {
	for (const child of owned) child.kill();
}
