// Role combinations for the actual release spatial/effect oracle. This only
// exercises the primary live route; delayed recordings and Rokuro's additional
// body source have their own integration tests.
function state(mod = 'SUPER_NEW_ROLES', phase = 1) {
	return {
		mod,
		map: 1,
		gameState: phase,
		lobbyCode: 'RUSTVOICE',
		hostId: 1,
		clientId: 1,
		isHost: true,
		lightRadius: 1,
		currentCamera: 7,
		closedDoors: [],
		players: [
			{ id: 0, clientId: 1, isLocal: true, x: 6.106, y: 2.7, name: 'Local' },
			{ id: 1, clientId: 2, x: 6.406, y: 2.7, name: 'Remote' },
		],
	};
}
function add(cases, s, rules, radios = [], shared = {}) {
	cases.push({ state: s, rules: { maxDistance: 5.32, ...rules }, preferences: { spatialAudio: true }, radios, shared });
}
function snrRole(name) {
	return {
		role: { value: 1, name },
		modifier: null,
		ghostRole: null,
		...(name === 'OtherNeutral' ? { isNeutral: true, canKill: true } : {}),
	};
}
function nosRole(p, name) {
	p.nosRole = { roleId: 1, roleName: name, displayName: name, runtimeClass: name, isRainbowStar: name === 'rainbow' };
	p.isImpostor = name === 'imp';
	p.isThirdParty = name.startsWith('neutral');
	p.nosPlayer = {
		isImpostor: p.isImpostor,
		isNeutral: p.isThirdParty,
		isKiller: ['imp', 'neutralKiller'].includes(name),
		speakerPositionX: p.x,
		speakerPositionY: p.y,
		bodyRateX: 1,
		bodyRateY: 1,
		bodyType: name === 'berserker' ? 2 : name === 'rokurokubi' ? 3 : 0,
		neckLength: name === 'rokurokubi' ? 2 : 0,
	};
}
export function modRoutingFixtures() {
	const cases = [];
	const names = ['Crewmate', 'Jackal', 'Sidekick', 'WaveCannonJackal', 'SidekickWaveCannon', 'OtherNeutral'];
	for (const first of names)
		for (const second of names)
			for (const phase of [0, 1, 2])
				for (const dead of [false, true])
					for (const otherDead of [false, true])
						for (const vents of [0, 1, 2, 3])
							for (const radio of [false, true]) {
								const s = state('SUPER_NEW_ROLES', phase),
									[me, other] = s.players;
								me.snrRole = snrRole(first);
								other.snrRole = snrRole(second);
								me.isDead = dead;
								other.isDead = otherDead;
								me.inVent = !!(vents & 1);
								other.inVent = !!(vents & 2);
								me.isImpostor = first === 'Crewmate';
								other.isImpostor = second === 'Crewmate';
								add(
									cases,
									s,
									{
										haunting: true,
										jackalHaunting: true,
										sidekickHaunting: true,
										jackalRadioEnabled: true,
										impostorRadioEnabled: true,
										jackalTalkInVents: vents % 2 === 0,
										sidekickTalkInVents: vents % 2 === 1,
										jackalHearOutsideVents: vents === 1,
										sidekickHearOutsideVents: vents === 2,
									},
									radio && !otherDead ? [2] : []
								);
							}
	for (const first of ['crew', 'imp', 'neutralKiller'])
		for (const second of [
			'crew',
			'imp',
			'neutralKiller',
			'neutralNoKill',
			'berserker',
			'rainbow',
			'busker',
			'rokurokubi',
		])
			for (const phase of [0, 1, 2])
				for (const dead of [false, true])
					for (const otherDead of [false, true])
						for (const mode of [0, 1, 2, 3]) {
							const s = state('NoS', phase),
								[me, other] = s.players;
							nosRole(me, first);
							nosRole(other, second);
							me.isDead = dead;
							other.isDead = otherDead;
							s.nosLocalMicPosition = { x: 6.206, y: 2.7 };
							other.nosPlayer.speakerPositionX = 6.606;
							other.nosIsPseudocide = second === 'busker';
							other.nativeNosRadioHearable0 = mode === 1;
							other.nativeNosRadioHearable1 = mode === 2;
							add(
								cases,
								s,
								{
									haunting: true,
									nosNeutralKillerHaunting: true,
									nosBuskerReviveHideVoice: mode === 3,
									nosVoicePositions: mode % 2 === 0,
									impostorRadioEnabled: true,
									jackalRadioEnabled: true,
									impostorRadioOnlyMode: mode === 3,
								},
								mode > 0 && !otherDead ? [2] : []
							);
						}
	for (const type of ['Impostor', 'Madmate', 'Crewmate', 'Neutral', 'Animals', 'Unknown'])
		for (const killer of [null, false, true])
			for (const vanilla of [false, true])
				for (const otherDead of [false, true])
					for (const phase of [0, 1, 2])
						for (const haunt of [false, true])
							for (const legacy of [0, 1, 2]) {
								const s = state('TOH4E', phase),
									[me, other] = s.players;
								me.isImpostor = vanilla;
								me.vanillaIsImpostor = vanilla;
								me.tohRole = {
									roleId: 1,
									roleName: 'Generated',
									customRoleType: type,
									isKiller: killer,
									isNeutralKiller: killer,
								};
								other.isDead = otherDead;
								add(cases, s, {
									haunting: haunt,
									tohNeutralKillerHaunting: legacy === 1,
									...(legacy === 2 ? { tohGhostRoles: { Generated: haunt } } : {}),
								});
							}
	for (const effect of [
		'berserker',
		'rokurokubi',
		'rainbow',
		'size',
		'citrus',
		'jamming',
		'megaphone',
		'hero',
		'disguise',
	])
		for (const strength of [0, 50, 100])
			for (const custom of [false, true]) {
				const s = state('NoS'),
					[me, other] = s.players;
				nosRole(me, 'crew');
				nosRole(other, effect);
				s.nosAddonIds = ['tanuki.bcl.roles'];
				if (effect === 'size') other.nosPlayer.bodyRateX = 1.5;
				if (effect === 'citrus') other.nosPlayer.hat = { name: 'noshat_catudon_Citrus_Lemon' };
				if (effect === 'jamming') {
					s.gameState = 2;
					s.nosVoiceJamming = [{ playerId: 1, muted: false, lowpass: true, pitch: 0.5 }];
				}
				if (effect === 'megaphone') s.nosMegaphones = [{ playerId: 1, range: 8, voiceEffect: true }];
				if (effect === 'hero') s.nosHeroTransforms = [{ playerId: 1, kind: 'super' }];
				if (effect === 'disguise') other.appearanceName = 'Changed';
				const keys = {
					berserker: 'nosBerserker',
					rokurokubi: 'nosRokurokubi',
					rainbow: 'nosRainbowStar',
					size: 'nosSize',
					citrus: 'nosCitrus',
					jamming: 'nosVoiceJamming',
					megaphone: 'nosMegaphone',
					hero: 'nosCitrus',
					disguise: 'disguise',
				};
				const strengthKeys = {
					nosBerserker: 'nosBerserkerVoiceEffectStrength',
					nosRokurokubi: 'nosRokurokubiVoiceEffectStrength',
					nosRainbowStar: 'nosRainbowStarEchoStrength',
					nosSize: 'nosSizeVoiceEffectStrength',
					nosCitrus: 'nosCitrusVoiceEffectStrength',
					nosVoiceJamming: 'nosVoiceJammingEffectStrength',
					nosMegaphone: 'nosMegaphoneEffectStrength',
					disguise: 'voiceEffectStrength',
				};
				const id = keys[effect],
					shared = {
						[strengthKeys[id]]: strength,
						...(custom ? { voiceEffectTunings: { [id]: { pitch: 25, reverb: 30, echo: 60 } } } : {}),
					};
				add(cases, s, {}, [], shared);
			}
	for (const dead of [false, true])
		for (const pushed of [false, true])
			for (const reverb of [false, true])
				for (const phase of [1, 2]) {
					const s = state('SUPER_NEW_ROLES', phase);
					s.players[1].isDead = dead;
					s.players[1].snrPushedFalling = pushed;
					s.players[1].snrPushOrigin = { x: 6.306, y: 2.7 };
					s.players[1].x = 25;
					add(cases, s, { snrPushReverb: reverb });
				}
	for (const mode of ['mute', 'quiet', 'normal'])
		for (const phase of [1, 2])
			for (const position of [false, true])
				for (const jammed of [false, true]) {
					const s = state('NoS', phase);
					s.nosAddonIds = ['UchuAddon', 'tanuki.bcl.roles'];
					for (const p of s.players) nosRole(p, 'crew');
					s.players[1].nosPlayer.addonData = 100;
					s.players[1].nosPlayer.speakerPositionX = 1000;
					s.players[1].nosPlayer.speakerPositionY = 1000;
					s.players[1].nosPlayer.isJammed = jammed;
					add(cases, s, {
						nosGluttonySwallowVoice: mode,
						nosVoicePositions: position,
						nosFixerJammingVoiceBlock: false,
						nosFixerJammingLowpass: true,
					});
				}
	// Listener-specific NoS endpoints remain authoritative, including radio bypasses.
	for (const addonData of [0, 100, 101, 228])
		for (const position of [false, true])
			for (const endpoint of [1, 20, 1000])
				for (const radios of [[], [2]]) {
					const s = state('NoS');
					s.nosAddonIds = ['UchuAddon'];
					for (const p of s.players) nosRole(p, 'crew');
					s.players[0].nosPlayer.micPositionX = 0;
					s.players[0].nosPlayer.micPositionY = 0;
					s.players[1].nosPlayer = { ...s.players[1].nosPlayer, addonData, speakerPositionX: endpoint, speakerPositionY: 0 };
					s.players[1].nativeNosRadioHearable0 = true;
					add(cases, s, { maxDistance: 5.32, impostorRadioEnabled: true, nosGluttonySwallowVoice: 'mute', nosVoicePositions: position }, radios);
				}
	for (const range of [0.5, 2, 8])
		for (const x of [0, 1, 5, 12])
			for (const dead of [false, true])
				for (const comms of [false, true]) {
					const s = state('NoS');
					s.nosAddonIds = ['tanuki.bcl.roles'];
					s.nosMegaphones = [{ playerId: 1, phase: 0, range, voiceEffect: false }];
					s.players[1].x = s.players[0].x + x;
					s.players[0].isDead = dead;
					s.comsSabotaged = comms;
					add(cases, s, { commsSabotage: true });
				}
	return cases;
}
