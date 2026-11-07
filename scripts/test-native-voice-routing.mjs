import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { loadVoiceMapSource, prepareVoiceMaps, segments } from './tauri-voice-maps.mjs';
import { startFixture } from './native-voice/fixture-server.mjs';
import { modRoutingFixtures } from './native-voice/mod-routing-fixtures.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const exe = resolve(option('--exe', join(root, `dist-tauri/TanukiBCL-Tauri-Beta-${version}/TanukiBCL-Tauri-Beta.exe`)));
const directory = join(root, '.tools/native-voice-routing', `run-${Date.now()}`);
await mkdir(directory, { recursive: true });
const maps = await prepareVoiceMaps({ check: true });
const oracle = await loadVoiceMapSource();
const baseRules = { maxDistance: 5.32, wallsBlockAudio: true, visionHearing: false };
function state(map, a, b, closedDoors = [], phase = 1) {
	return {
		mod: 'NONE',
		map,
		closedDoors,
		gameState: phase,
		lobbyCode: 'RUSTVOICE',
		hostId: 1,
		clientId: 1,
		isHost: true,
		lightRadius: 2,
		players: [
			{ id: 0, clientId: 1, isLocal: true, x: a[0], y: a[1] },
			{ id: 1, clientId: 2, x: b[0], y: b[1] },
		],
	};
}
function expected(c) {
	const [me, other] = c.state.players;
	const settings = { ...c.shared, enableSpatialAudio: c.preferences?.spatialAudio ?? true, ghostVolumeAsImpostor: 100 };
	const distance = oracle.voiceHearingDistance(c.state, c.rules, me);
	const audio = oracle.calculateVoiceAudio({
		state: c.state,
		me,
		other,
		settings,
		activeLobbySettings: c.rules,
		maxDistance: distance,
		impostorRadioClientId: -1,
		impostorRadioClientIds: c.radios ?? [],
		airshipSpawnFallback: c.state.nativeAirshipSpawnFallback,
		nosJackalRadioHearable: other.nativeNosRadioHearable1,
		nosImpostorRadioHearable: other.nativeNosRadioHearable0,
	});
	oracle.applyVoiceJamming(c.state, other.id, audio);
	if (c.state.mod === 'NoS' && [1, 2].includes(c.state.gameState) && c.state.nosLimitSpeechMuted?.includes(other.id))
		audio.gain = 0;
	const [x, y] = audio.panPosition ?? [0, 0];
	const d = Math.hypot(x, y, 0.5);
	const attenuation = Math.max(0, 1 - Math.max(0, d - 0.1) / ((audio.panMaxDistance ?? distance) - 0.1));
	const gain = audio.gain * attenuation;
	const angle = (Math.atan2(x, 0.5) + Math.PI / 2) / 2;
	const effect = audio.gain > 0 ? oracle.selectVoiceEffect(c.state, settings, c.rules, me, other, -1, c.radios) : null;
	const tunings = effect ? [effect.tuning] : [];
	if (audio.gain > 0 && oracle.shouldApplyRainbowStarEcho(c.state, other, c.rules, settings))
		tunings.push(oracle.getVoiceEffectTuning(settings, 'nosRainbowStar'));
	const falling = audio.reverbStrength !== undefined;
	if (audio.gain > 0 && falling && c.rules.snrPushReverb !== false)
		tunings.push(oracle.getVoiceEffectTuning(settings, 'snrPush'));
	const tuning = oracle.combineVoiceEffectTunings(tunings);
	const ordinaryReverb = falling ? false : audio.reverb;
	const reverb = ordinaryReverb === true || tuning.reverb > 0;
	const reverbWet =
		(ordinaryReverb === true
			? Math.max(tuning.reverb, audio.reverbStrength ?? 100)
			: tuning.reverb > 0
				? tuning.reverb
				: reverb
					? 100
					: 0) / 100;
	const grit =
		effect?.id === 'nosBerserker'
			? Math.max(Math.abs(effect.tuning.pitch), effect.tuning.reverb, effect.tuning.echo) / 100
			: 0;
	return {
		blocked: oracle.poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, c.state.map, c.state.closedDoors),
		distance,
		gains: [gain * Math.cos(angle), gain * Math.sin(angle)],
		effects: {
			pitch: tuning.pitch === 0 ? null : { pitch: 2 ** (tuning.pitch / 100), formant: 1, squash: 0 },
			echo: tuning.echo / 100,
			filter: audio.muffle
				? { highpass: audio.muffle.type === 'highpass', frequency: audio.muffle.frequency, q: audio.muffle.q }
				: null,
			reverb,
			reverbWet,
			radioEcho: audio.radioEcho,
			...(grit > 0 ? { berserker: grit } : {}),
		},
	};
}
const cases = [];
function add(s, rules = baseRules, spatialAudio = true, radios = []) {
	cases.push({ state: structuredClone(s), rules: { ...rules }, preferences: { spatialAudio }, radios });
}
let seed = 0x72e1a95;
const random = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) / 2 ** 32;
};
for (const map of [0, 1, 2, 3, 4, 5]) {
	const sourceMap = map === 3 ? 0 : map;
	const doors = Object.keys(oracle.doorMaps[sourceMap] ?? {}).map(Number);
	for (let n = 0; n < 800; n++) {
		const a = [random() * 70 - 30, random() * 55 - 30];
		const b = [a[0] + random() * 12 - 6, a[1] + random() * 12 - 6];
		add(state(map, a, b, n % 2 ? doors : []));
	}
	const world = (x, y) => [(x - 40) * (map === 3 ? -1 : 1), 40 - y];
	// Probe both sides of every release wall segment, including the curves/chords.
	for (const path of oracle.colliderMaps[sourceMap]) {
		for (const [x1, y1, x2, y2] of segments(path)) {
			const length = Math.hypot(x2 - x1, y2 - y1);
			if (length < 1e-9) continue;
			const x = (x1 + x2) / 2,
				y = (y1 + y2) / 2;
			const dx = (-(y2 - y1) / length) * 0.1,
				dy = ((x2 - x1) / length) * 0.1;
			const a = world(x - dx, y - dy),
				b = world(x + dx, y + dy);
			add(state(map, a, b));
			add(state(map, b, a));
			add(state(map, world(x1, y1), world(x1, y1)));
		}
	}
	for (const [id, path] of Object.entries(oracle.doorMaps[sourceMap] ?? {})) {
		if (!path) continue;
		for (const [x1, y1, x2, y2] of segments(path)) {
			const length = Math.hypot(x2 - x1, y2 - y1);
			if (!length) continue;
			const x = (x1 + x2) / 2,
				y = (y1 + y2) / 2;
			const dx = (-(y2 - y1) / length) * 0.2,
				dy = ((x2 - x1) / length) * 0.2;
			for (const closed of [[], [Number(id)], [999], doors])
				add(state(map, world(x - dx, y - dy), world(x + dx, y + dy), closed));
		}
	}
}
// Listener-specific lights, life, meeting and spatial-disabled combinations.
for (const phase of [0, 1, 2, 3, 4])
	for (const dead of [false, true])
		for (const otherDead of [false, true])
			for (const impostor of [false, true])
				for (const lightRadius of [0, 0.1, 0.3, 1, 2, 5])
					for (const spatial of [true, false]) {
						const s = state(1, [6.106, 2.7], [6.106, 3.1], [0], phase);
						s.players[0].isDead = dead;
						s.players[1].isDead = otherDead;
						s.players[0].isImpostor = impostor;
						s.lightRadius = lightRadius;
						add(s, { ...baseRules, visionHearing: true }, spatial);
					}
for (const map of [0, 4])
	for (const phase of [0, 1, 2])
		for (const fallback of [false, true]) {
			const s = state(map, [0, 0], [30, 0], [], phase);
			s.airshipMeetingByOutfit = fallback;
			add(s);
		}
for (const radius of [0, 0.5, 0.6, 0.61, 1, 5.32, 10])
	for (const x of [0, 0.1, 0.59, 0.8, 1, 2, 5.32, 10])
		add(state(1, [6.106, 2.7], [6.106 + x, 2.7]), { ...baseRules, maxDistance: radius, wallsBlockAudio: false });

for (const map of [0, 2, 4])
	for (const camera of [0, 1, 2, 3, 4, 5, 6, 7])
		for (const phase of [0, 1, 2])
			for (const dead of [false, true])
				for (const spatial of [false, true]) {
					const position = Object.values(oracle.AmongUsMaps[map].cameras)[0];
					const s = state(map, [0, 20], [position.x + 0.5, position.y], [], phase);
					s.currentCamera = camera;
					s.players[0].isDead = dead;
					if (camera < 6 && !oracle.AmongUsMaps[map].cameras[camera]) continue;
					add(s, { ...baseRules, hearThroughCameras: true }, spatial);
				}
for (const phase of [0, 1, 2])
	for (const dead of [false, true])
		for (const otherDead of [false, true])
			for (const impostor of [false, true])
				for (const otherImpostor of [false, true])
					for (const haunting of [false, true])
						for (const radioOnly of [false, true])
							for (const radio of [false, true])
								for (const x of [1, 20]) {
									const s = state(1, [0, 0], [x, 0], [], phase);
									s.players[0].isDead = dead;
									s.players[1].isDead = otherDead;
									s.players[0].isImpostor = impostor;
									s.players[1].isImpostor = otherImpostor;
									add(
										s,
										{ maxDistance: 5.32, haunting, impostorRadioEnabled: true, impostorRadioOnlyMode: radioOnly },
										true,
										radio && !otherDead && otherImpostor ? [2] : []
									);
								}
for (const meVent of [false, true])
	for (const otherVent of [false, true])
		for (const dead of [false, true])
			for (const otherDead of [false, true])
				for (const hearVent of [false, true])
					for (const twoVents of [false, true]) {
						const s = state(1, [6.106, 2.7], [6.106, 3.1]);
						s.players[0].inVent = meVent;
						s.players[1].inVent = otherVent;
						s.players[0].isDead = dead;
						s.players[1].isDead = otherDead;
						add(s, { maxDistance: 5.32, hearImpostorsInVents: hearVent, impostersHearImpostersInvent: twoVents });
					}
// Shapeshift/disguise source-filter selection, custom tunings and radio bypass.
for (const phase of [0, 1, 2])
	for (const dead of [false, true])
		for (const impostor of [false, true])
			for (const radio of [false, true])
				for (const enabled of [false, true])
					for (const strength of [0, 50, 100]) {
						const s = state(1, [6, 2.7], [6, 3.1], [], phase);
						s.players[0].isDead = dead;
						s.players[0].isImpostor = impostor;
						s.players[1].isImpostor = true;
						s.players[1].name = 'Original';
						s.players[1].appearanceName = 'Disguise';
						add(
							s,
							{ maxDistance: 5.32, voiceEffectEnabled: enabled, impostorRadioEnabled: true },
							true,
							radio ? [2] : []
						);
						cases.at(-1).shared = { voiceEffectStrength: strength };
						add(
							s,
							{ maxDistance: 5.32, voiceEffectEnabled: enabled, impostorRadioEnabled: true },
							true,
							radio ? [2] : []
						);
						cases.at(-1).shared = { voiceEffectTunings: { disguise: { pitch: 25, reverb: 30, echo: 60 } } };
					}
cases.push(...modRoutingFixtures());
const expectedResults = cases.map(expected);
let blockedCases = 0;
const differences = [];
for (let offset = 0; offset < cases.length; offset += 2000) {
	const input = join(directory, `input-${offset}.json`),
		output = join(directory, `output-${offset}.json`);
	const slice = cases.slice(offset, offset + 2000);
	await writeFile(input, JSON.stringify(slice));
	execFileSync(exe, ['--voice-routing-probe', '--voice-test-config', input, '--voice-test-output', output], {
		windowsHide: true,
		timeout: 30000,
	});
	const results = JSON.parse(await readFile(output, 'utf8'));
	assert.equal(results.length, slice.length);
	for (const [i, actual] of results.entries()) {
		const want = expectedResults[offset + i];
		const context = () => JSON.stringify({ index: offset + i, case: slice[i], actual, want });
		if (
			actual.blocked !== want.blocked ||
			Math.abs(actual.distance - want.distance) >= 1e-9 ||
			!actual.gains.every((v, ch) => Math.abs(v - want.gains[ch]) < 1e-6) ||
			(actual.gains.some((g) => g > 0) && !isDeepStrictEqual(actual.effects, want.effects))
		)
			differences.push(context());
		if (actual.blocked) blockedCases++;
	}
}
assert.equal(
	differences.length,
	0,
	JSON.stringify({ differences: differences.length, examples: differences.slice(0, 6).map(JSON.parse) })
);
assert.ok(blockedCases > 1000);
const report = {
	schema: 1,
	version,
	passed: true,
	cases: cases.length,
	blockedCases,
	maps: [0, 1, 2, 3, 4, 5],
	mapSegments: maps.segments,
	oracle: 'v3.2.62 spatialAudio.ts / ColliderMap.ts / path-intersection 4.1.0',
	limitations: [
		'Fixed game inputs; does not exercise live game memory, physical doors/lights, microphones or internet TURN.',
		'Compares routing and attenuation with the Rust balance formula; not final Web Audio sound or panning equivalence.',
	],
	executableSha256: createHash('sha256')
		.update(await readFile(exe))
		.digest('hex'),
	transport: [],
};
console.log(JSON.stringify({ event: 'routing-parity-passed', cases: cases.length, blockedCases }));

if (args.includes('--transport')) {
	const owned = new Set();
	function launch(params) {
		const child = spawn(exe, params, { cwd: dirname(exe), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
		owned.add(child);
		let log = '';
		child.stderr.on('data', (data) => (log = (log + data).slice(-4000)));
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
	for (const closed of [false, true]) {
		const server = await startFixture();
		try {
			const results = [];
			for (const client of [1, 2]) {
				const game = state(1, [6.106, 2.7], [6.106, 3.1], closed ? [0] : []);
				game.clientId = client;
				game.isHost = client === 1;
				game.players.forEach((p) => (p.isLocal = p.clientId === client));
				const config = join(directory, `transport-${closed}-${client}.json`),
					output = join(directory, `transport-${closed}-${client}-result.json`);
				await writeFile(
					config,
					JSON.stringify({
						serverUrl: server.url,
						game,
						frequency: client === 1 ? 440 : 660,
						lobbySettings: { ...baseRules, visionHearing: true },
					})
				);
				const child = launch([
					'--native-voice-probe',
					'--voice-test-config',
					config,
					'--voice-test-output',
					output,
					'--voice-test-seconds',
					'12',
				]);
				results.push({ child, output });
			}
			await Promise.all(results.map((r) => r.child.finished));
			const metrics = [];
			for (const { output } of results) {
				const result = JSON.parse(await readFile(output, 'utf8'));
				assert.equal(result.status.error, '');
				assert.ok(result.metrics.sentPackets > 200 && result.metrics.receivedPackets > 200);
				assert.ok(result.metrics.decodedFrames > 48000);
				if (closed) assert.equal(result.metrics.outputEnergy, 0);
				else assert.ok(result.metrics.outputEnergy > 10000);
				metrics.push(result.metrics);
			}
			report.transport.push({ closedDoor: closed, seconds: 12, passed: true, metrics });
			console.log(JSON.stringify({ event: 'transport-passed', closedDoor: closed }));
		} finally {
			for (const child of owned) child.kill();
			await Promise.allSettled([...owned].map((c) => c.finished));
			await server.close();
		}
	}
}
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, directory }));
