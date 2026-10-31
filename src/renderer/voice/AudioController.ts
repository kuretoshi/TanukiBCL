import { connectReverbMix, createReverbMix, reverbLevels } from './reverbMix';
import { setEffectGain } from './effectGain';
import { createVoicePeakGuard } from './voicePeakGuard';
import { applyVoiceJamming } from '../../common/VoiceJammingState';
import { Player, AmongUsState, GameState } from '../../common/AmongUsState';
import { hasTanukiAddon } from '../../common/tanukiAddon';
import { MapType } from '../../common/AmongusMap';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import { combineVoiceEffectTunings, getVoiceEffectTuning, VoiceEffectTuning } from '../../common/VoiceEffectTuning';
import { IpcRendererMessages } from '../../common/ipc-messages';
import { pushToTalkOptions } from '../../common/pushToTalkOptions';
import { ipcRenderer } from '../lib/electron-bridge';
import { captureMicrophone } from '../lib/captureMicrophone';
import { TypedEmitter } from '../lib/TypedEmitter';
import VAD, { VADOptions } from '../lib/vad';
import SettingsStore from '../settings/SettingsStore';
import { calculateVoiceAudio } from './spatialAudio';
import { calculateRokuroVoice, createRokuroVoice } from './rokuroVoice';
import { ExtendedAudioElement, PeerAudioNodes, RadioEchoNodes } from './types';
import { createTunedVoiceEffect } from './tunedVoiceEffect';
import { createBibiriEcho, updateBibiriEcho, disconnectBibiriEcho, stopBibiriEcho } from './bibiriEcho';
import { createMegaphoneRecording } from './megaphoneRecording';
import { createInterviewerRecording } from './interviewerRecording';
import { HeroSpeech } from './heroSpeech';
import { createDyingVoiceRecording, inDyingVoiceRange } from './dyingVoiceRecording';
import { selectVoiceEffect, shouldApplyRainbowStarEcho } from './voiceEffectRules';

import { prepareSourceFilter, disconnectProcessingEffect } from './sourceFilterEffect';

interface VadNode {
	connect: () => void;
	destroy: () => void;
	options: VADOptions;
	init: () => void;
}

interface AudioControllerEvents extends Record<string, unknown[]> {
	voiceRoleSample: [rms: number, active: boolean];
	talking: [boolean];
	muteStateChanged: [muted: boolean, deafened: boolean];
	peerAudioReady: [peerId: string];
	error: [string];
}

const REVERB_URL = import.meta.env.DEV
	? `${window.location.origin}/sounds/reverb.ogx`
	: 'app://bundle/sounds/reverb.ogx';

export class AudioController extends TypedEmitter<AudioControllerEvents> {
	private started = false;
	private sourceFilterReady = false;
	private startToken = 0;
	private inputToken = 0;
	private interviewer?: ReturnType<typeof createInterviewerRecording>;
	private heroSpeech?: HeroSpeech;
	private speechPlatforms = new Map<string, unknown>();
	private tanukiAddonActive = false;
	private interviewMic?: { stream: MediaStream; source: MediaStreamAudioSourceNode };
	private interviewMuted = new Set<string>();
	private inputStream?: MediaStream;
	private stream?: MediaStream;
	private context?: AudioContext;
	private masterGain?: GainNode;
	private masterDestination?: MediaStreamAudioDestinationNode;
	private masterElement?: ExtendedAudioElement;
	private useContextSink = false;
	private microphoneGain?: GainNode;
	private inputSource?: MediaStreamAudioSourceNode;
	private localMegaphoneRecording?: ReturnType<typeof createMegaphoneRecording>;
	private inputDestination?: MediaStreamAudioDestinationNode;
	private audioListener?: VadNode;
	private remoteVoiceInput = false;
	private voiceRoleAnalyser?: AnalyserNode;
	private voiceRoleTimer?: ReturnType<typeof setInterval>;
	private convolverBuffer: AudioBuffer | null = null;
	private peers = new Map<string, PeerAudioNodes>();
	private ipcHandlers: [string, (...args: unknown[]) => void][] = [];

	private pushToTalkMode: number = pushToTalkOptions.VOICE;
	private pushToTalkPressed = false;
	private mutedState = false;
	private deafenedState = false;
	private jammedState = false;
	private radioPending = false;
	private localRadioPending = false;
	private maxDistance = 2;
	private lastGameState?: AmongUsState;
	private airshipSpawnUntil = 0;

	get outboundStream(): MediaStream | undefined {
		return this.stream;
	}

	get muted(): boolean {
		return this.mutedState;
	}

	get deafened(): boolean {
		return this.deafenedState;
	}

	get running(): boolean {
		return this.started;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const token = ++this.startToken;
		const inputToken = ++this.inputToken;

		const settings = SettingsStore.store;
		this.pushToTalkMode = settings.pushToTalkMode;

		const context = new AudioContext();
		this.context = context;
		void context.resume().catch(() => {
			/* resumed on first user gesture instead */
		});
		this.createOutputBus(settings.speaker);
		void this.loadConvolverBuffer();

		try {
			this.sourceFilterReady = false;
			try {
				await prepareSourceFilter(context);
				this.sourceFilterReady = this.context === context && token === this.startToken;
			} catch (error) {
				console.warn('NoS source-filter audio is unavailable', error);
			}
			await this.createInputChain(settings, token, inputToken);
		} catch (error) {
			if (token === this.startToken) {
				this.started = false;
				this.teardownGraph();
			}
			throw error;
		}

		if (token !== this.startToken) return;
		if (!this.started) {
			this.teardownInputChain();
			this.teardownGraph();
			return;
		}

		this.applyTrackEnabled();
		this.registerHotkeys();
	}

	async restartInput(): Promise<MediaStreamTrack | undefined> {
		if (!this.started || !this.context) return undefined;
		const token = this.startToken;
		const inputToken = ++this.inputToken;

		this.teardownInputChain();
		try {
			await this.createInputChain(SettingsStore.store, token, inputToken);
		} catch {
			return undefined;
		}
		if (token !== this.startToken || inputToken !== this.inputToken) return undefined;
		if (!this.started) {
			this.teardownInputChain();
			return undefined;
		}

		this.applyTrackEnabled();
		return this.stream?.getAudioTracks()[0];
	}

	private async createInputChain(settings: ISettings, token: number, inputToken: number): Promise<void> {
		const context = this.context;
		if (!context || !this.started || token !== this.startToken || inputToken !== this.inputToken) return;

		const constraints: MediaTrackConstraints & Record<string, unknown> = {
			autoGainControl: settings.autoGainControl,
			channelCount: 2,
			echoCancellation: settings.echoCancellation,
			latency: 0,
			noiseSuppression: settings.noiseSuppression, // @ts-ignore-line
			googNoiseSuppression: settings.noiseSuppression, // @ts-ignore-line
			googEchoCancellation: settings.echoCancellation, // @ts-ignore-line
			googAutoGainControl: settings.autoGainControl, // @ts-ignore-line
			googTypingNoiseDetection: settings.noiseSuppression, // @ts-ignore-line
			sampleRate: settings.oldSampleDebug ? 48000 : undefined,
		};
		let inputStream: MediaStream;
		let usedDefault = false;
		try {
			({ stream: inputStream, usedDefault } = await captureMicrophone(constraints, settings.microphone));
		} catch (error) {
			if (token !== this.startToken || inputToken !== this.inputToken) return;
			this.emit('error', "Couldn't connect to your microphone:\n" + error);
			throw error;
		}

		if (!this.started || token !== this.startToken || inputToken !== this.inputToken) {
			inputStream.getTracks().forEach((track) => track.stop());
			return;
		}

		this.inputStream = inputStream;
		this.stream = inputStream;

		const source = context.createMediaStreamSource(inputStream);
		this.inputSource = source;
		this.syncTanukiAddon(this.lastGameState);

		if ((settings.microphoneGainEnabled || settings.micSensitivityEnabled) && !settings.autoGainControl) {
			const microphoneGain = context.createGain();
			const destination = context.createMediaStreamDestination();
			source.connect(microphoneGain);
			microphoneGain.gain.value = settings.microphoneGainEnabled ? settings.microphoneGain / 100 : 1;
			microphoneGain.connect(destination);
			this.microphoneGain = microphoneGain;
			this.inputDestination = destination;
			this.stream = destination.stream;
		}

		const audioListener = VAD(context, source, undefined, {
			onVoiceStart: () => {
				const current = SettingsStore.store;
				if (this.microphoneGain && current.micSensitivityEnabled && !current.autoGainControl) {
					openMicrophoneGate(this.microphoneGain, current.microphoneGainEnabled ? current.microphoneGain / 100 : 1);
				}
				this.emit('talking', true);
			},
			onVoiceStop: () => {
				if (this.microphoneGain && SettingsStore.store.micSensitivityEnabled && !SettingsStore.store.autoGainControl) {
					closeMicrophoneGate(this.microphoneGain);
				}
				this.emit('talking', false);
			},
			noiseCaptureDuration: 0,
			stereo: false,
		}) as VadNode;

		audioListener.options.minNoiseLevel =
			settings.micSensitivityEnabled && !settings.autoGainControl ? settings.micSensitivity : 0.15;
		audioListener.options.maxNoiseLevel = 1;
		audioListener.init();
		this.audioListener = audioListener;
		if (usedDefault && SettingsStore.store.microphone === settings.microphone) {
			console.warn('Selected microphone is unavailable; switched to the default input');
			SettingsStore.set('microphone', 'default');
		}
	}

	private startTanukiInput(): void {
		const context = this.context;
		const source = this.inputSource;
		if (!context || !source || !this.masterGain) return;
		this.localMegaphoneRecording ??= createMegaphoneRecording(
			context,
			source,
			this.masterGain,
			() =>
				!!this.inputStream?.getAudioTracks()[0]?.enabled &&
				!this.mutedState &&
				!this.remoteVoiceInput &&
				!this.deafenedState &&
				!this.jammedState
		);
		if (this.voiceRoleAnalyser) return;
		const analyser = context.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = 0;
		source.connect(analyser);
		this.voiceRoleAnalyser = analyser;
		const samples = new Float32Array(analyser.fftSize);
		this.voiceRoleTimer = setInterval(() => {
			if (
				this.voiceRoleAnalyser !== analyser ||
				!hasTanukiAddon(this.lastGameState) ||
				![GameState.TASKS, GameState.DISCUSSION, GameState.LOBBY].includes(this.lastGameState.gameState)
			)
				return;
			analyser.getFloatTimeDomainData(samples);
			let sum = 0;
			for (const sample of samples) sum += sample * sample;
			const track = this.inputStream?.getAudioTracks()[0];
			const active =
				!!track &&
				track.enabled &&
				track.readyState === 'live' &&
				!track.muted &&
				!this.mutedState &&
				!this.remoteVoiceInput &&
				!this.deafenedState &&
				!this.jammedState;
			this.emit('voiceRoleSample', Math.min(1, Math.sqrt(sum / samples.length)), active);
		}, 50);
	}

	private stopTanukiInput(): void {
		this.localMegaphoneRecording?.disconnect();
		this.localMegaphoneRecording = undefined;
		const wasSampling = this.voiceRoleTimer !== undefined;
		if (wasSampling) clearInterval(this.voiceRoleTimer);
		this.voiceRoleTimer = undefined;
		if (this.voiceRoleAnalyser) {
			try {
				this.inputSource?.disconnect(this.voiceRoleAnalyser);
			} catch {
				/* The input may already have been disconnected. */
			}
		}
		this.voiceRoleAnalyser?.disconnect();
		this.voiceRoleAnalyser = undefined;
		if (wasSampling) this.emit('voiceRoleSample', 0, false);
	}

	private teardownInputChain(): void {
		this.stopTanukiInput();
		this.audioListener?.destroy();
		this.audioListener = undefined;

		this.interviewer?.removeInput('local');
		this.heroSpeech?.removeInput('local');
		this.interviewMic?.source.disconnect();
		this.interviewMic = undefined;
		this.inputSource?.disconnect();
		this.inputSource = undefined;

		this.microphoneGain?.disconnect();
		this.microphoneGain = undefined;

		this.inputDestination?.disconnect();
		this.inputDestination = undefined;

		this.inputStream?.getTracks().forEach((track) => track.stop());
		this.inputStream = undefined;
		this.stream = undefined;
	}

	stop(): void {
		this.startToken++;
		this.inputToken++;
		if (!this.started) {
			this.removeAllListeners();
			return;
		}
		this.started = false;

		this.unregisterHotkeys();

		for (const peerId of Array.from(this.peers.keys())) {
			this.removePeer(peerId);
		}

		this.teardownInputChain();
		this.teardownGraph();

		this.mutedState = false;
		this.deafenedState = false;
		this.jammedState = false;
		this.radioPending = false;
		this.localRadioPending = false;
		this.pushToTalkPressed = false;
		this.removeAllListeners();
	}

	private createOutputBus(speaker: string): void {
		const context = this.context;
		if (!context) return;

		const masterGain = context.createGain();
		masterGain.gain.value = 1;
		this.masterGain = masterGain;
		this.syncTanukiAddon(this.lastGameState);

		this.useContextSink = 'setSinkId' in AudioContext.prototype;
		if (this.useContextSink) {
			masterGain.connect(context.destination);
		} else {
			const masterDestination = context.createMediaStreamDestination();
			masterGain.connect(masterDestination);
			const element = document.createElement('audio') as ExtendedAudioElement;
			document.body.appendChild(element);
			element.setAttribute('autoplay', '');
			element.srcObject = masterDestination.stream;
			this.masterDestination = masterDestination;
			this.masterElement = element;
		}

		this.setSpeaker(speaker);
	}

	private teardownGraph(): void {
		this.teardownTanukiAddon();
		this.speechPlatforms.clear();
		this.masterGain?.disconnect();
		this.masterGain = undefined;
		this.masterDestination?.disconnect();
		this.masterDestination = undefined;

		if (this.masterElement) {
			this.teardownAudioElement(this.masterElement);
			this.masterElement = undefined;
		}

		const context = this.context;
		this.context = undefined;
		if (context) {
			context.close().catch(() => {
				/* already closed */
			});
		}
	}

	setSpeaker(deviceId: string): void {
		const sinkId = !deviceId || deviceId.toLowerCase() === 'default' ? '' : deviceId;
		const onError = (error: unknown) => console.warn('Failed to set audio output device', error);

		if (this.useContextSink) {
			const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined;
			context?.setSinkId?.(sinkId).catch(onError);
			return;
		}

		this.masterElement?.setSinkId(sinkId).catch(onError);
	}

	private async loadConvolverBuffer(): Promise<void> {
		const context = this.context;
		if (!context) return;
		try {
			const response = await fetch(REVERB_URL);
			const buffer = await context.decodeAudioData(await response.arrayBuffer());
			this.convolverBuffer = buffer;
			for (const peer of this.peers.values()) {
				if (peer.reverb) peer.reverb.buffer = buffer;
			}
		} catch (error) {
			console.warn('Failed to load reverb impulse response', error);
		}
	}

	private registerHotkeys(): void {
		const add = (channel: string, handler: (...args: unknown[]) => void) => {
			ipcRenderer.on(channel, handler);
			this.ipcHandlers.push([channel, handler]);
		};

		add(IpcRendererMessages.TOGGLE_DEAFEN, () => this.toggleDeafen());
		add(IpcRendererMessages.TOGGLE_MUTE, () => this.toggleMute());
		add(IpcRendererMessages.PUSH_TO_TALK, (_: unknown, pressing: boolean) => {
			this.pushToTalkPressed = pressing;
			this.applyTrackEnabled();
		});
		add(IpcRendererMessages.RADIO_PENDING, (_: unknown, pending: boolean) => {
			if (this.radioPending === pending) return;
			this.radioPending = pending;
			this.applyTrackEnabled();
		});
	}

	private unregisterHotkeys(): void {
		for (const [channel, handler] of this.ipcHandlers) {
			ipcRenderer.off(channel, handler);
		}
		this.ipcHandlers = [];
	}

	setRemoteVoiceInput(enabled: boolean): void {
		this.remoteVoiceInput = enabled;
		this.applyTrackEnabled();
	}

	setLocalRadioPending(pending: boolean): void {
		if (this.localRadioPending === pending) return;
		this.localRadioPending = pending;
		this.applyTrackEnabled();
	}

	private applyTrackEnabled(): void {
		const track = this.inputStream?.getAudioTracks()[0];
		if (!track) return;
		track.enabled =
			!this.remoteVoiceInput &&
			!this.deafenedState &&
			!this.mutedState &&
			!this.jammedState &&
			!this.radioPending &&
			!this.localRadioPending &&
			(this.pushToTalkMode === pushToTalkOptions.PUSH_TO_TALK
				? this.pushToTalkPressed
				: this.pushToTalkMode === pushToTalkOptions.PUSH_TO_MUTE
					? !this.pushToTalkPressed
					: true);
		const outboundTrack = this.stream?.getAudioTracks()[0];
		if (outboundTrack && outboundTrack !== track)
			outboundTrack.enabled =
				!this.remoteVoiceInput && !this.jammedState && !this.radioPending && !this.localRadioPending;
	}

	setJammed(jammed: boolean): void {
		if (this.jammedState === jammed) return;
		this.jammedState = jammed;
		this.applyTrackEnabled();
	}

	setPushToTalkMode(mode: number): void {
		this.pushToTalkMode = mode;
		this.applyTrackEnabled();
	}

	toggleMute(): void {
		this.mutedState = !this.mutedState;
		if (this.deafenedState) {
			this.deafenedState = false;
			this.mutedState = false;
		}
		this.applyTrackEnabled();
		this.emit('muteStateChanged', this.mutedState, this.deafenedState);
	}

	toggleDeafen(): void {
		this.deafenedState = !this.deafenedState;
		if (this.deafenedState) this.interviewer?.silence();
		if (this.deafenedState) this.localMegaphoneRecording?.cancel();
		if (this.deafenedState)
			for (const peer of this.peers.values()) {
				peer.dyingVoiceRecording?.setVolume(0);
				peer.megaphoneRecording?.cancel();
				if (peer.bibiriEcho) stopBibiriEcho(peer.bibiriEcho);
			}
		this.applyTrackEnabled();
		this.emit('muteStateChanged', this.mutedState, this.deafenedState);
	}

	updateMicrophoneSettings(settings: ISettings): void {
		if (!this.microphoneGain?.gain) return;
		if (settings.autoGainControl) return;
		if (!settings.microphoneGainEnabled && !settings.micSensitivityEnabled) return;

		if (!settings.micSensitivityEnabled) {
			this.microphoneGain.gain.value = settings.microphoneGainEnabled ? settings.microphoneGain / 100 : 1;
		}
		if (this.audioListener?.options) {
			this.audioListener.options.minNoiseLevel = settings.micSensitivityEnabled ? settings.micSensitivity : 0.15;
			this.audioListener.init();
		}
	}

	setMaxDistance(maxDistance: number): void {
		this.maxDistance = maxDistance;
		for (const peer of this.peers.values()) {
			peer.pan.maxDistance = maxDistance;
		}
	}

	hasPeer(peerId: string): boolean {
		return this.peers.has(peerId);
	}

	addPeer(peerId: string, stream: MediaStream): void {
		if (this.peers.get(peerId)?.stream === stream) return;
		this.removePeer(peerId);

		const context = this.context;
		const masterGain = this.masterGain;
		if (!context || !masterGain) return;

		void context.resume().catch(() => {
			/* resumed on first user gesture instead */
		});

		const dummyAudioElement = new Audio();
		dummyAudioElement.srcObject = stream;

		const source = context.createMediaStreamSource(stream);

		const gain = context.createGain();
		gain.gain.value = 0;

		const pan = context.createPanner();
		pan.refDistance = 0.1;
		pan.panningModel = 'equalpower';
		pan.distanceModel = 'linear';
		pan.maxDistance = this.maxDistance;
		pan.rolloffFactor = 1;

		source.connect(pan);
		pan.connect(gain);
		gain.connect(masterGain);

		const peer: PeerAudioNodes = {
			voiceEffectConnected: false,
			stream,
			dummyAudioElement,
			gain,
			pan,
			muffleConnected: false,
			reverbConnected: false,
			radioEchoConnected: false,
			source,
		};
		this.peers.set(peerId, peer);
		if (hasTanukiAddon(this.lastGameState)) this.createTanukiPeer(peer);

		this.emit('peerAudioReady', peerId);
	}

	removePeer(peerId: string): void {
		this.speechPlatforms.delete(peerId);
		this.interviewer?.removeInput(peerId);
		this.heroSpeech?.removeInput(peerId);
		this.interviewMuted.delete(peerId);
		const peer = this.peers.get(peerId);
		if (!peer) return;
		this.peers.delete(peerId);
		this.destroyTanukiPeer(peer);
		if (peer.voiceEffect) disconnectProcessingEffect(peer.voiceEffect);
		peer.peakGuard?.disconnect();
		peer.rokuroVoice?.disconnect();

		this.teardownAudioElement(peer.dummyAudioElement);
		peer.source.disconnect();
		peer.pan.disconnect();
		peer.gain.disconnect();
		peer.reverb?.disconnect();
		if (peer.reverbMix) for (const node of Object.values(peer.reverbMix)) node.disconnect();
		peer.muffle?.disconnect();
		if (peer.radioEcho) disconnectRadioEcho(peer.radioEcho);
	}

	private createTanukiPeer(peer: PeerAudioNodes): void {
		if (!this.context || !this.masterGain) return;
		peer.dyingVoiceRecording ??= createDyingVoiceRecording(this.context, peer.source, this.masterGain);
		peer.megaphoneRecording ??= createMegaphoneRecording(this.context, peer.source, this.masterGain);
		peer.bibiriEcho ??= createBibiriEcho(this.context, peer.gain, this.masterGain);
	}

	private destroyTanukiPeer(peer: PeerAudioNodes): void {
		peer.megaphoneRecording?.disconnect();
		peer.megaphoneRecording = undefined;
		peer.dyingVoiceRecording?.disconnect();
		peer.dyingVoiceRecording = undefined;
		if (!peer.bibiriEcho) return;
		try {
			peer.gain.disconnect(peer.bibiriEcho.input);
		} catch {
			/* The normal voice graph may already have been removed. */
		}
		disconnectBibiriEcho(peer.bibiriEcho);
		peer.bibiriEcho = undefined;
	}

	private syncTanukiAddon(state: AmongUsState | undefined): void {
		if (!hasTanukiAddon(state)) {
			if (this.tanukiAddonActive) this.teardownTanukiAddon();
			return;
		}
		if (!this.context || !this.masterGain) return;
		this.tanukiAddonActive = true;
		this.interviewer ??= createInterviewerRecording(this.context, this.masterGain);
		if (!this.heroSpeech) {
			this.heroSpeech = new HeroSpeech(this.context);
			this.heroSpeech.setContext(state);
			for (const [id, platform] of this.speechPlatforms) this.heroSpeech.setPeerPlatform(id, platform);
		}
		this.startTanukiInput();
		for (const peer of this.peers.values()) this.createTanukiPeer(peer);
	}

	private teardownTanukiAddon(): void {
		this.tanukiAddonActive = false;
		this.stopTanukiInput();
		this.heroSpeech?.dispose();
		this.heroSpeech = undefined;
		this.interviewer?.disconnect();
		this.interviewer = undefined;
		this.interviewMic?.source.disconnect();
		this.interviewMic = undefined;
		for (const peer of this.peers.values()) this.destroyTanukiPeer(peer);
	}

	private teardownAudioElement(element: HTMLAudioElement): void {
		element.pause();
		if (element.srcObject) {
			(element.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
		}
		element.removeAttribute('src');
		element.srcObject = null;
		element.load();
		element.remove();
	}

	private clearVoiceEffect(peer: PeerAudioNodes): void {
		if (!peer.voiceEffect) return;
		disconnectProcessingEffect(peer.voiceEffect);
		peer.voiceEffect = undefined;
		if (this.masterGain)
			rebuildEffectChain(
				peer,
				peer.rokuroVoice?.mix ?? this.masterGain,
				peer.reverbConnected,
				peer.muffleConnected,
				peer.radioEchoConnected,
				false
			);
	}

	silenceAllPeers(): void {
		this.interviewer?.clear();
		this.localMegaphoneRecording?.cancel();
		for (const peer of this.peers.values()) peer.megaphoneRecording?.cancel();
		for (const [peerId, peer] of this.peers) {
			peer.dyingVoiceRecording?.cancel();
			this.setPeerGain(peerId, 0);
			if (peer.bibiriEcho) stopBibiriEcho(peer.bibiriEcho);
			this.clearVoiceEffect(peer);
		}
	}

	silencePeersExcept(peerIds: string[]): void {
		for (const [peerId, peer] of this.peers) {
			if (!peerIds.includes(peerId)) {
				peer.dyingVoiceRecording?.cancel();
				peer.megaphoneRecording?.cancel();
				this.setPeerGain(peerId, 0);
				if (peer.bibiriEcho) stopBibiriEcho(peer.bibiriEcho);
				this.clearVoiceEffect(peer);
			}
		}
	}

	private updateInterviewer(state: AmongUsState): void {
		const local = state.players.find((player) => player.isLocal);
		if (local && this.stream && this.context) {
			if (this.interviewMic?.stream !== this.stream) {
				this.interviewMic?.source.disconnect();
				this.interviewMic = { stream: this.stream, source: this.context.createMediaStreamSource(this.stream) };
			}
			this.interviewer?.setInput(
				'local',
				this.interviewMic.source,
				local.id,
				() =>
					!this.mutedState &&
					!this.deafenedState &&
					!this.jammedState &&
					!this.remoteVoiceInput &&
					!!this.stream?.getAudioTracks()[0]?.enabled
			);
		}
		this.interviewer?.update(
			state.nosInterviews ?? [],
			state.mod === 'NoS' && (state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION),
			state.gameState === GameState.DISCUSSION,
			this.deafenedState ? 0 : SettingsStore.store.masterVolume / 100,
			Date.now()
		);
	}

	private updateTanukiState(state: AmongUsState): void {
		this.heroSpeech?.setContext(state);
		const heroLocal = state.players.find((player) => player.isLocal);
		if (heroLocal && this.inputSource)
			this.heroSpeech?.setInput(
				'local',
				this.inputSource,
				heroLocal.id,
				() =>
					!this.mutedState &&
					!this.deafenedState &&
					!this.jammedState &&
					!this.remoteVoiceInput &&
					!!this.inputStream?.getAudioTracks()[0]?.enabled
			);
		this.updateInterviewer(state);
		if (state.mod !== 'NoS' || (state.gameState !== GameState.TASKS && state.gameState !== GameState.DISCUSSION))
			for (const peer of this.peers.values()) peer.dyingVoiceRecording?.cancel();
		const local = state.players.find((player) => player.isLocal);
		this.localMegaphoneRecording?.update(
			state.nosMegaphones?.find((entry) => entry.playerId === local?.id),
			state.mod === 'NoS' &&
				state.gameState === GameState.TASKS &&
				!!local &&
				!local.disconnected &&
				!this.deafenedState,
			SettingsStore.store.masterVolume / 100
		);
		if (state.mod !== 'NoS' || state.gameState !== GameState.TASKS)
			for (const peer of this.peers.values()) peer.megaphoneRecording?.cancel();
		if (state.mod !== 'NoS' || (state.gameState !== GameState.TASKS && state.gameState !== GameState.DISCUSSION)) {
			for (const peer of this.peers.values())
				if (peer.bibiriEcho) updateBibiriEcho(peer.bibiriEcho, false, false, undefined);
		}
	}

	updateGameState(state: AmongUsState): void {
		this.syncTanukiAddon(state);
		if (hasTanukiAddon(state)) this.updateTanukiState(state);
		if (this.lastGameState !== state) {
			const previousState = this.lastGameState;
			this.lastGameState = state;
			if (state.map !== MapType.AIRSHIP || state.gameState !== GameState.TASKS) this.airshipSpawnUntil = 0;
			else if (
				(previousState?.gameState !== GameState.TASKS && state.oldGameState === GameState.DISCUSSION) ||
				(previousState?.debug?.meetingHudState !== 4 && state.debug?.meetingHudState === 4)
			)
				this.airshipSpawnUntil = Date.now() + 15000;
		}
	}

	setSpeechPlatform(peerId: string, platform: unknown): void {
		this.speechPlatforms.set(peerId, platform);
		this.heroSpeech?.setPeerPlatform(peerId, platform);
	}
	setPeerGain(peerId: string, gain: number): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		const headGain = peer.rokuroVoice?.setGain(gain) ?? gain;
		peer.gain.gain.value = headGain;
		// Mute downstream tails as well as new speech, without changing the selected graph.
		for (const output of [peer.voiceEffect?.output, peer.reverbMix?.output, peer.radioEcho?.output])
			if (output) output.gain.value = headGain > 0 ? 1 : 0;
	}

	stopPeerDeathEcho(peerId: string): void {
		this.peers.get(peerId)?.megaphoneRecording?.cancel();
		const echo = this.peers.get(peerId)?.bibiriEcho;
		if (echo) stopBibiriEcho(echo);
	}

	/**
	 * Returns the pre-volume gain for the peer, or `null` when the peer has no audio graph yet.
	 */
	applyVoiceAudio(
		peerId: string,
		state: AmongUsState,
		settings: ISettings,
		activeLobbySettings: ILobbySettings,
		me: Player,
		other: Player,
		impostorRadioClientId: number,
		impostorRadioClientIds?: readonly number[],
		nosJackalRadioHearable = false,
		nosImpostorRadioHearable = false
	): number | null {
		const peer = this.peers.get(peerId);
		const destination = this.masterGain;
		if (!peer || !destination) return null;
		if (hasTanukiAddon(state)) {
			this.heroSpeech?.setInput(peerId, peer.source, other.id, () => !other.disconnected && !other.isDead);
			this.interviewer?.setInput(
				peerId,
				peer.source,
				other.id,
				() => !this.deafenedState && !other.disconnected && !this.interviewMuted.has(peerId)
			);
			const message = state.nosDyingVoices?.find((entry) => entry.playerId === other.id);
			const nearMessage = inDyingVoiceRange(message, me, state.gameState === GameState.TASKS);
			peer.dyingVoiceRecording?.update(
				message,
				state.mod === 'NoS' &&
					(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
					other.isDead &&
					!other.disconnected,
				nearMessage && !this.deafenedState
			);
			peer.megaphoneRecording?.update(
				state.nosMegaphones?.find((entry) => entry.playerId === other.id),
				state.mod === 'NoS' && state.gameState === GameState.TASKS && !other.disconnected && !this.deafenedState,
				settings.masterVolume / 100
			);
			if (peer.bibiriEcho)
				updateBibiriEcho(
					peer.bibiriEcho,
					state.mod === 'NoS' &&
						!other.disconnected &&
						(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION),
					other.isDead,
					state.nosBibiriEchoes?.find((e) => e.playerId === other.id)?.unixMs,
					Date.now(),
					getVoiceEffectTuning(settings, 'nosBibiri'),
					this.convolverBuffer,
					this.sourceFilterReady
				);
		}
		const { pan } = peer;
		const voiceInput = {
			airshipSpawnFallback:
				state.map === MapType.AIRSHIP && state.gameState === GameState.TASKS && Date.now() < this.airshipSpawnUntil,
			state,
			settings,
			activeLobbySettings,
			me,
			other,
			maxDistance: this.maxDistance,
			impostorRadioClientId,
			impostorRadioClientIds,
			nosJackalRadioHearable,
			nosImpostorRadioHearable,
		};
		const result = calculateVoiceAudio(voiceInput);

		// Restore the ordinary attenuation radius when a megaphone charge ends.
		applyVoiceJamming(state, other.id, result);
		const rokuro = calculateRokuroVoice(voiceInput);
		if (rokuro && this.context) {
			if (!peer.rokuroVoice) {
				peer.rokuroVoice = createRokuroVoice(this.context, peer.source, destination);
				peer.rokuroDestinationChanged = true;
			}
		} else if (peer.rokuroVoice) {
			peer.rokuroVoice.disconnect();
			peer.rokuroVoice = undefined;
			peer.rokuroDestinationChanged = true;
		}
		pan.maxDistance = result.panMaxDistance ?? this.maxDistance;

		if (result.muffle && this.context) {
			peer.muffle ??= this.context.createBiquadFilter();
			peer.muffle.type = result.muffle.type;
			peer.muffle.frequency.value = result.muffle.frequency;
			peer.muffle.Q.value = result.muffle.q;
		}

		const effect =
			result.gain > 0
				? selectVoiceEffect(
						state,
						settings,
						activeLobbySettings,
						me,
						other,
						impostorRadioClientId,
						impostorRadioClientIds
					)
				: null;
		const tunings: VoiceEffectTuning[] = effect ? [effect.tuning] : [];
		if (result.gain > 0 && shouldApplyRainbowStarEcho(state, other, activeLobbySettings, settings))
			tunings.push(getVoiceEffectTuning(settings, 'nosRainbowStar'));
		const falling = result.reverbStrength !== undefined;
		if (result.gain > 0 && falling && activeLobbySettings.snrPushReverb !== false)
			tunings.push(getVoiceEffectTuning(settings, 'snrPush'));
		const tuning = combineVoiceEffectTunings(tunings);
		const roleReverb = !!this.convolverBuffer && tuning.reverb > 0;
		const ordinaryReverb = falling ? false : result.reverb;
		const wantReverb =
			roleReverb || (ordinaryReverb === null ? peer.reverbConnected && !peer.roleReverbConnected : ordinaryReverb);
		if (wantReverb && this.context) {
			if (!peer.reverb) {
				peer.reverb = this.context.createConvolver();
				peer.reverb.buffer = this.convolverBuffer;
			}
			peer.reverbMix ??= createReverbMix(this.context);
			const strength =
				ordinaryReverb === true
					? Math.max(tuning.reverb, result.reverbStrength ?? 100)
					: roleReverb
						? tuning.reverb
						: 100;
			const levels = reverbLevels(strength);
			setEffectGain(peer.reverbMix.dry, levels.dry);
			setEffectGain(peer.reverbMix.wet, levels.wet);
		}
		const wantMuffle = result.muffle === null ? peer.muffleConnected : result.muffle !== false;
		const wantRadioEcho = result.radioEcho;
		if (wantRadioEcho && this.context) peer.radioEcho ??= createRadioEcho(this.context);
		const grit =
			effect?.id === 'nosBerserker'
				? Math.max(Math.abs(effect.tuning.pitch), effect.tuning.reverb, effect.tuning.echo)
				: 0;
		const wantProcessing = tuning.pitch !== 0 || tuning.echo > 0 || grit > 0;
		if (wantProcessing && this.context) {
			if (peer.voiceEffect && (!('kind' in peer.voiceEffect) || peer.voiceEffect.kind !== 'tuned')) {
				disconnectProcessingEffect(peer.voiceEffect);
				peer.voiceEffect = undefined;
				peer.voiceEffectConnected = false;
			}
			peer.voiceEffect ??= createTunedVoiceEffect(this.context);
			if ('kind' in peer.voiceEffect && peer.voiceEffect.kind === 'tuned')
				peer.voiceEffect.update(tuning, grit, this.sourceFilterReady);
		} else if (peer.voiceEffect) {
			disconnectProcessingEffect(peer.voiceEffect);
			peer.voiceEffect = undefined;
		}
		rebuildEffectChain(
			peer,
			peer.rokuroVoice?.mix ?? destination,
			wantReverb,
			wantMuffle,
			wantRadioEcho,
			wantProcessing
		);
		peer.roleReverbConnected = roleReverb && peer.reverbConnected;

		if (result.panPosition) {
			const time = pan.context.currentTime;
			pan.positionX.setValueAtTime(result.panPosition[0], time);
			pan.positionY.setValueAtTime(result.panPosition[1], time);
			pan.positionZ.setValueAtTime(-0.5, time);
		}

		return rokuro && peer.rokuroVoice
			? peer.rokuroVoice.configure(
					(result.gain * rokuro.settings.headVolume) / 100,
					(rokuro.body.gain * rokuro.settings.bodyVolume) / 100,
					rokuro.body.panPosition,
					rokuro.body.panMaxDistance ?? this.maxDistance,
					rokuro.settings.bodyEcho,
					rokuro.body.muffle ? rokuro.body.muffle.frequency : 1800
				)
			: result.gain;
	}
	setMegaphonePlaybackVolume(peerId: string, volume: number): void {
		if (volume > 0) this.interviewMuted.delete(peerId);
		else this.interviewMuted.add(peerId);
		this.peers.get(peerId)?.dyingVoiceRecording?.setVolume(volume);
		const echo = this.peers.get(peerId)?.bibiriEcho;
		if (echo && volume <= 0) stopBibiriEcho(echo);
		this.peers.get(peerId)?.megaphoneRecording?.setVolume(volume);
	}
}

function rebuildEffectChain(
	peer: PeerAudioNodes,
	destination: AudioNode,
	wantReverb: boolean,
	wantMuffle: boolean,
	wantRadioEcho: boolean,
	wantVoiceEffect: boolean
): void {
	const effect = peer.voiceEffect;
	const wantPeakGuard =
		wantReverb ||
		(wantVoiceEffect &&
			!!effect &&
			(!('kind' in effect) || effect.kind !== 'tuned' || !!(effect.pitch || effect.berserker || effect.echo)));
	if (
		peer.reverbConnected === wantReverb &&
		peer.muffleConnected === wantMuffle &&
		peer.radioEchoConnected === wantRadioEcho &&
		peer.voiceEffectConnected === wantVoiceEffect &&
		!!peer.peakGuard === wantPeakGuard &&
		!peer.rokuroDestinationChanged
	)
		return;
	peer.rokuroDestinationChanged = false;

	for (const node of [peer.gain, peer.muffle, peer.reverb, peer.radioEcho?.output]) {
		try {
			node?.disconnect();
		} catch {
			/* not connected */
		}
	}
	peer.peakGuard?.output.disconnect();
	// Chain rebuilds disconnect gain, including this live audio tap.
	if (peer.bibiriEcho) peer.gain.connect(peer.bibiriEcho.input);

	const chain: AudioNode[] = [peer.gain];
	if (wantVoiceEffect && peer.voiceEffect) {
		peer.voiceEffect.output.disconnect();
		peer.gain.connect(peer.voiceEffect.input);
		chain[0] = peer.voiceEffect.output;
	}
	if (wantMuffle && peer.muffle) chain.push(peer.muffle);
	if (peer.reverbMix) for (const node of Object.values(peer.reverbMix)) node.disconnect();

	try {
		for (let index = 0; index < chain.length - 1; index++) {
			chain[index].connect(chain[index + 1]);
		}
		let chainOutput = chain[chain.length - 1];
		if (wantReverb && peer.reverb && peer.reverbMix) {
			chainOutput = connectReverbMix(chainOutput, peer.reverb, peer.reverbMix);
		} else if (wantReverb && peer.reverb) {
			chainOutput.connect(peer.reverb);
			chainOutput = peer.reverb;
		}
		if (wantRadioEcho && peer.radioEcho) {
			chainOutput.connect(peer.radioEcho.input);
			chainOutput = peer.radioEcho.output;
		}
		if (wantPeakGuard) {
			peer.peakGuard ??= createVoicePeakGuard(peer.gain.context);
			chainOutput.connect(peer.peakGuard.input);
			chainOutput = peer.peakGuard.output;
		} else {
			peer.peakGuard?.disconnect();
			peer.peakGuard = undefined;
		}
		chainOutput.connect(destination);
		peer.reverbConnected = wantReverb;
		peer.muffleConnected = wantMuffle;
		peer.radioEchoConnected = wantRadioEcho;
		peer.voiceEffectConnected = wantVoiceEffect;
	} catch (error) {
		console.warn('Failed to rebuild audio effect chain', error);
		peer.reverbConnected = false;
		peer.muffleConnected = false;
		peer.radioEchoConnected = false;
		peer.voiceEffectConnected = false;
		try {
			peer.gain.connect(destination);
		} catch {
			/* destination already gone */
		}
	}
}

function createRadioEcho(context: AudioContext): RadioEchoNodes {
	const input = context.createGain();
	const output = context.createGain();
	const dry = context.createGain();
	const wet = context.createGain();
	const delay = context.createDelay(0.25);
	const feedback = context.createGain();

	dry.gain.value = 0.92;
	wet.gain.value = 0.2;
	delay.delayTime.value = 0.09;
	feedback.gain.value = 0.12;

	input.connect(dry);
	dry.connect(output);
	input.connect(delay);
	delay.connect(wet);
	wet.connect(output);
	delay.connect(feedback);
	feedback.connect(delay);

	return { input, output, dry, wet, delay, feedback };
}

function disconnectRadioEcho(effect: RadioEchoNodes): void {
	for (const node of [effect.input, effect.output, effect.dry, effect.wet, effect.delay, effect.feedback]) {
		try {
			node.disconnect();
		} catch {
			/* not connected */
		}
	}
}

const MICROPHONE_RELEASE_SECONDS = 0.02;

function openMicrophoneGate(node: GainNode, level: number): void {
	const now = node.context.currentTime;
	node.gain.cancelScheduledValues(now);
	node.gain.setValueAtTime(level, now);
}

function closeMicrophoneGate(node: GainNode): void {
	const current = node.gain.value;
	if (current === 0) return;
	const now = node.context.currentTime;
	node.gain.cancelScheduledValues(now);
	node.gain.setValueAtTime(current, now);
	node.gain.linearRampToValueAtTime(0, now + MICROPHONE_RELEASE_SECONDS);
}
