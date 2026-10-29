import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';

const mobile = resolve(process.env.BCL_MOBILE_REPO ?? '../BetterCrewlink-mobile');
const dir = await mkdtemp(join(tmpdir(), 'tanuki-mobile-roles-'));
const udp = createSocket('udp4');
let sender;
try {
	let index = 0;
	async function bundle(entry) {
		const result = await build({
			entryPoints: [resolve(entry)],
			bundle: true,
			platform: 'node',
			format: 'esm',
			write: false,
		});
		const file = join(dir, `${index++}.mjs`);
		await writeFile(file, result.outputFiles[0].contents);
		return import(pathToFileURL(file));
	}
	const { RemoteVoiceRoleInput, voiceRoleIdentity } = await bundle('src/common/RemoteVoiceRole.ts');
	const { VoiceRoleClient } = await bundle(join(mobile, 'src/app/services/voice-role-client.ts'));
	const { VoiceRoleSources } = await bundle('src/common/VoiceRoleSource.ts');
	const { NosVoiceRoleSender } = await bundle('src/main/nosVoiceRoleBridge.ts');
	const player = { id: 7, clientId: 42, isLocal: true, isDead: false, disconnected: false };
	const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: 1, lobbyCode: 'ABCDEF', players: [player] };
	const client = { playerId: 7, clientId: 42 };
	const packets = [];
	udp.on('message', (data) => packets.push(data.toString().split('|')));
	await new Promise((r) => udp.bind(0, '127.0.0.1', r));
	const descriptor = {
		protocol: 1,
		role: 'tanukiVoiceRoles',
		pid: 123,
		playerId: 7,
		port: udp.address().port,
		token: 'a'.repeat(32),
	};
	const descriptorPath = join(dir, 'voice-role.json');
	await writeFile(descriptorPath, JSON.stringify(descriptor));
	sender = new NosVoiceRoleSender(descriptorPath, 59999);
	const input = new RemoteVoiceRoleInput();
	input.enable(voiceRoleIdentity(state, player), 'abcdef123456');
	let ack,
		lastSample,
		outgoing = 0;
	const phone = new VoiceRoleClient(
		(target, data) => {
			outgoing++;
			if (data.request) {
				assert.equal(target, state.lobbyCode);
				ack = input.request('phone', client, data.request, 'b'.repeat(32));
				if (ack) phone.receive('pc', client, ack, state, player);
			} else {
				assert.equal(target, 'pc');
				lastSample = data.sample;
				const sample = input.sample('phone', client, data.sample);
				if (sample) sender.send(sample.rms, sample.active, 123, state);
			}
		},
		() => {}
	);
	phone.enable('ABCDEF123456');
	phone.sample(0.4, true, state, player, true, Date.now());
	await delay(65);
	assert.equal(packets.length, 1, 'Web mic -> paired PC -> authenticated local NoS UDP');
	assert.equal(packets[0][4], '0.4');
	phone.sample(0.4, false, state, player, true, Date.now());
	await delay(65);
	assert.equal(packets[1][5], '0', 'mobile mute forwarded explicitly, not mistaken for disconnect');
	assert.equal(input.sample('attacker', client, { ...lastSample, sequence: 99 }), undefined);
	assert.equal(input.sample('phone', { ...client, playerId: 8 }, { ...lastSample, sequence: 99 }), undefined);
	assert.equal(input.sample('phone', client, lastSample), undefined, 'replay rejected');
	for (const patch of [
		{ rms: NaN },
		{ rms: 2 },
		{ active: 'yes' },
		{ session: 'c'.repeat(32) },
		{ lobbyCode: 'OTHER' },
		{ lease: 'f'.repeat(32) },
		{ sequence: 1.5 },
	])
		assert.equal(input.sample('phone', client, { ...lastSample, sequence: 99, ...patch }), undefined);
	assert.equal(
		input.sample('phone', client, { ...lastSample, sequence: 99 }, Date.now() + 2500),
		undefined,
		'expired PC-issued lease blocks queued stale microphone'
	);
	const before = outgoing;
	phone.sample(0.9, true, state, player, true, Date.now() - 1600);
	assert.equal(outgoing, before, 'stale host frame never drives a voice role');
	phone.sample(0.9, true, state, player, false, Date.now());
	assert.equal(outgoing, before, 'disconnected socket sends nothing');
	phone.sample(0.4, true, { ...state, lobbyCode: 'OTHER' }, player, true, Date.now());
	assert.equal(phone.code, '', 'lobby switch revokes pairing');
	input.sync({ ...voiceRoleIdentity(state, player), clientId: 43 });
	assert.equal(input.code, '', 'PC identity change revokes pairing');
	phone.enable('bad');
	assert.equal(phone.code, '');

	// Same local UDP endpoint supports laser, Bibiri, Talkative and lobby microphone test.
	for (const [role, gameState] of [
		['tanukiMegaphone', 1],
		['tanukiBclBibiri', 2],
		['tanukiTalkative', 2],
		['tanukiMicTest', 0],
	]) {
		await writeFile(descriptorPath, JSON.stringify({ ...descriptor, role }));
		await delay(260);
		const count = packets.length;
		sender.send(0.2, true, 123, { ...state, gameState });
		await delay(40);
		assert.equal(packets.length, count + 1, `${role} supports relayed microphone`);
	}
	const routes = new VoiceRoleSources();
	const clients = { pc: client, phone: client, other: { playerId: 8, clientId: 43 } };
	assert.equal(
		routes.receive(client, { ...voiceRoleIdentity(state, player), peerId: 'phone' }, 'ABCDEF', clients, 100),
		true
	);
	assert.equal(
		routes.apply({ 42: 'pc' }, clients, 200)[42],
		'phone',
		'PC reconnect cannot replace the paired mobile audio'
	);
	assert.equal(
		routes.receive(client, { ...voiceRoleIdentity(state, player), peerId: 'other' }, 'ABCDEF', clients),
		false
	);
	assert.equal(routes.apply({ 42: 'pc' }, clients, 2701)[42], 'pc', 'expired source routing is cleared');

	const desktopAudio = await bundle('src/renderer/voice/spatialAudio.ts');
	const mobileAudio = await bundle(join(mobile, 'src/app/voice/spatialAudio.ts'));
	const desktopEffect = await bundle('src/renderer/voice/voiceEffectRules.ts');
	const mobileEffect = await bundle(join(mobile, 'src/app/voice/voiceEffectRules.ts'));
	const me = { id: 1, x: 0, y: 0 };
	const other = { id: 2, x: 8, y: 0 };
	const base = {
		state: { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: 1, map: 0, lightRadiusChanged: false },
		settings: { enableSpatialAudio: true },
		activeLobbySettings: {},
		maxDistance: 5.32,
		impostorRadioClientId: -1,
		me,
		other,
	};
	for (const patch of [
		{ nosPortableMegaphones: [{ playerId: 2, extraRange: 5 }] },
		{ nosMegaphones: [{ playerId: 2, range: 10, energy: 0.5 }] },
		{ nosPortableMegaphones: [] },
		{ gameState: 2, nosMegaphones: [{ playerId: 2, range: 10, energy: 0.5 }] },
	]) {
		const input = { ...base, state: { ...base.state, ...patch } };
		assert.deepEqual(mobileAudio.calculateVoiceAudio(input), desktopAudio.calculateVoiceAudio(input));
		for (const extra of [
			{},
			{ other: { ...other, isDead: true } },
			{ activeLobbySettings: { deadOnly: true } },
			{ activeLobbySettings: { commsSabotage: true }, state: { ...input.state, comsSabotaged: true } },
			{ other: { ...other, nosPlayer: { isJammed: true } } },
		]) {
			assert.deepEqual(
				mobileAudio.calculateVoiceAudio({ ...input, ...extra }),
				desktopAudio.calculateVoiceAudio({ ...input, ...extra })
			);
		}
	}
	const oldNow = Date.now;
	Date.now = () => 100;
	try {
		const charge = { ...base.state, nosMegaphones: [{ playerId: 2, range: 10, energy: 0.5 }] };
		assert.deepEqual(
			mobileEffect.selectVoiceEffect(charge, {}, {}, me, other, -1),
			desktopEffect.selectVoiceEffect(charge, {}, {}, me, other, -1)
		);
	} finally {
		Date.now = oldNow;
	}
	function deathTail(module) {
		const automation = [],
			snapshots = [];
		let nodeId = 0;
		const context = { currentTime: 0, createGain: node, createDelay: node };
		function node() {
			const id = nodeId++;
			const param = () => ({
				value: 0,
				cancelScheduledValues: (...args) => automation.push([id, 'cancel', ...args]),
				setValueAtTime: (...args) => automation.push([id, 'set', ...args]),
				exponentialRampToValueAtTime: (...args) => automation.push([id, 'ramp', ...args]),
			});
			return { context, gain: param(), delayTime: param(), connect() {}, disconnect() {} };
		}
		const effect = module.createBibiriEcho(context, node(), node());
		for (const [active, dead, event, now] of [
			[true, false, undefined, 1000],
			[true, true, 1000, 1000],
			[true, true, 1000, 1500],
			[false, true, undefined, 2000],
			[true, false, undefined, 4000],
		]) {
			context.currentTime = now / 1000;
			module.updateBibiriEcho(effect, active, dead, event, now);
			snapshots.push([effect.input.gain.value, effect.seen, effect.wasAlive, effect.until]);
		}
		module.disconnectBibiriEcho(effect);
		return { automation, snapshots };
	}
	assert.deepEqual(
		deathTail(await bundle(join(mobile, 'src/app/voice/bibiriEcho.ts'))),
		deathTail(await bundle('src/renderer/voice/bibiriEcho.ts')),
		'default death-tail automation and lifecycle stay compatible on Web/APK'
	);
	console.log(
		'Web/APK: real UDP relay, roles/meeting/mic test, mute, identity, replay/lease/freshness checks, paired audio routing and desktop audio parity passed.'
	);
} finally {
	sender?.close();
	udp.close();
	await rm(dir, { recursive: true, force: true });
}
