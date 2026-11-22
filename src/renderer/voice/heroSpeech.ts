import { StonePcm, stoneAudioWindow } from '../../common/VoiceStoneAudio';
import { LiveSpeechAudio } from '../../common/LiveSpeechAudio';
import {
	heardTransformation,
	heardForbiddenWord,
	shouldRecogniseSpeech,
	type SpeechPlatform,
	type HeroSpeechState,
	type HeroSpeechPlayer,
} from '../../common/HeroSpeech';
import { GameState, type AmongUsState } from '../../common/AmongUsState';
import { hasTanukiAddon } from '../../common/tanukiAddon';
import { ipcRenderer } from '../lib/electron-bridge';
import { recognisedStoneWord } from '../../common/VoiceStoneSpeech';

type Message = { result?: { text?: string; partial?: string; result?: unknown } };
interface Recognizer {
	on(event: string, callback: (message: Message) => void): void;
	acceptWaveform(buffer: AudioBuffer): void;
	remove(): void;
	setWords?(enabled: boolean): void;
}
interface Model {
	KaldiRecognizer: new (rate: number) => Recognizer;
	terminate(): void;
}
interface VoskGlobal {
	createModel(url: string, logLevel: number): Promise<Model>;
}
let libraryPromise: Promise<VoskGlobal> | undefined;
function asset(name: string): string {
	return import.meta.env.DEV ? `${window.location.origin}/speech/${name}` : `app://bundle/speech/${name}`;
}
function loadLibrary(): Promise<VoskGlobal> {
	return (libraryPromise ??= new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = asset('vosk.js');
		script.onload = () => resolve((window as unknown as { Vosk: VoskGlobal }).Vosk);
		script.onerror = () => {
			libraryPromise = undefined;
			reject(new Error('音声認識ライブラリを読み込めませんでした。'));
		};
		document.head.appendChild(script);
	}));
}
interface Input {
	source: AudioNode;
	player: number;
	allowed: () => boolean;
}
interface Capture {
	player: number;
	key: string;
	session: string;
	signature: string;
	jobs: HeroSpeechPlayer[];
	recognizer: Recognizer;
	processor: ScriptProcessorNode;
	silent: GainNode;
	input: Input;
	partialAt: number;
}
export class HeroSpeech {
	private live = new Map<
		number,
		{
			key: string;
			input: Input;
			session: string;
			signature: string;
			jobs: HeroSpeechPlayer[];
			audio: LiveSpeechAudio;
			busy: boolean;
			processor: ScriptProcessorNode;
			silent: GainNode;
		}
	>();
	private needsVosk = false;
	private recordings = new Map<
		string,
		{
			job: HeroSpeechPlayer;
			session: string;
			input: Input;
			recorder: StonePcm;
			warm: { at: number; samples: Float32Array }[];
			processor: ScriptProcessorNode;
			silent: GainNode;
		}
	>();
	private inputs = new Map<string, Input>();
	private captures = new Map<number, Capture>();
	private platforms = new Map<string, { platform: SpeechPlatform; until: number }>();
	private handled = new Set<string>();
	private model?: Model;
	private loading = false;
	private disposed = false;
	private polling = false;
	private enabled = false;
	private host = false;
	private local = -1;
	private lobby = '';
	private state?: HeroSpeechState;
	private retryAt = 0;
	private timer?: ReturnType<typeof setInterval>;
	constructor(private context: AudioContext) {}
	setContext(state: AmongUsState): void {
		if (this.lobby !== state.lobbyCode) {
			this.platforms.clear();
			this.clear();
		}
		this.lobby = state.lobbyCode;
		this.host = state.isHost;
		this.local = state.players.find((p) => p.isLocal)?.id ?? -1;
		this.enabled = hasTanukiAddon(state) && [GameState.TASKS, GameState.DISCUSSION].includes(state.gameState);
		if (!this.enabled) {
			if (this.timer !== undefined) clearInterval(this.timer);
			this.timer = undefined;
			this.clear();
		} else if (this.timer === undefined) {
			this.timer = setInterval(() => {
				void this.poll();
			}, 200);
		}
	}
	setPeerPlatform(key: string, platform: unknown): void {
		if (platform === 'desktop' || platform === 'web' || platform === 'mobile')
			this.platforms.set(key, { platform, until: Date.now() + 6500 });
		else this.platforms.delete(key);
	}
	setInput(key: string, source: AudioNode, player: number, allowed: () => boolean): void {
		const old = this.inputs.get(key);
		if (old?.source === source && old.player === player) {
			old.allowed = allowed;
			return;
		}
		this.removeCaptureForInput(key);
		this.inputs.set(key, { source, player, allowed });
	}
	removeInput(key: string): void {
		this.removeCaptureForInput(key);
		this.inputs.delete(key);
		this.platforms.delete(key);
	}
	private removeCaptureForInput(key: string): void {
		const input = this.inputs.get(key);
		for (const [id, capture] of this.recordings) if (capture.input === input) this.stopRecording(id);
		for (const [player, capture] of this.captures) if (capture.key === key) this.stop(player);
		for (const [player, capture] of this.live) if (capture.key === key) this.stopLive(player);
	}
	private permitted(key: string, input: Input): boolean {
		const identity = this.platforms.get(key);
		return shouldRecogniseSpeech(
			key === 'local' && input.player === this.local,
			this.host,
			identity && identity.until > Date.now() ? identity.platform : undefined
		);
	}
	private selected(state: HeroSpeechState): HeroSpeechPlayer[] {
		return state.players.filter((job) =>
			[...this.inputs].some(([key, input]) => input.player === job.playerId && this.permitted(key, input))
		);
	}
	private async poll(): Promise<void> {
		if (this.disposed || !this.enabled || this.polling) return;
		this.polling = true;
		try {
			await this.pollCore();
		} catch (error) {
			this.clear();
			console.warn('音声認識連携を停止しました。', error);
		} finally {
			this.polling = false;
		}
	}
	private async pollCore(): Promise<void> {
		const state = (await ipcRenderer.invoke('NOS_HERO_SPEECH_STATE')) as HeroSpeechState | null;
		if (this.disposed || !this.enabled) return;
		if (!state) {
			this.clear();
			return;
		}
		if (this.state?.session !== state.session) this.clear();
		this.state = state;
		const selected = this.selected(state);
		const neural = state.localNeuralConfigured ? selected : [];
		const recordedJobs = neural.filter(
			(p) => p.kind === 'stone' && (p.recognizer === 'local-neural' || p.request === 0)
		);
		const jobs = selected.filter(
			(p) =>
				p.recognizer !== 'local-neural' && !(state.localNeuralConfigured && (p.kind !== 'stone' || p.request === 0))
		);
		this.reconcileRecording(recordedJobs, state.session);
		this.reconcileLive(
			neural.filter((p) => p.kind !== 'stone'),
			state.session
		);
		this.needsVosk = jobs.length > 0;
		if (jobs.length) void this.ensureModel();
		else if (this.model) {
			for (const id of this.captures.keys()) this.stop(id);
			this.model.terminate();
			this.model = undefined;
		}
		ipcRenderer.send(
			'NOS_HERO_SPEECH_READY',
			state.session,
			[...new Set([...neural, ...(this.model ? jobs : [])].map((p) => p.playerId))],
			[...new Set(neural.filter((p) => p.kind === 'stone').map((p) => p.playerId))]
		);
		this.reconcile(jobs);
	}
	private reconcileLive(jobs: HeroSpeechPlayer[], session: string): void {
		const groups = new Map<number, HeroSpeechPlayer[]>();
		for (const job of jobs)
			if (job.request > 0 && job.expires > Date.now())
				groups.set(job.playerId, [...(groups.get(job.playerId) ?? []), job]);
		for (const [id, c] of this.live) {
			const current = groups.get(id);
			if (
				!current ||
				c.session !== session ||
				c.signature !== this.signature(current) ||
				!this.permitted(c.key, c.input) ||
				!c.input.allowed()
			)
				this.stopLive(id);
			else c.jobs = current;
		}
		for (const [id, entries] of groups) {
			if (!this.live.has(id)) {
				const found = [...this.inputs].find(([key, i]) => i.player === id && this.permitted(key, i) && i.allowed());
				if (!found) continue;
				const [key, input] = found,
					processor = this.context.createScriptProcessor(2048, 1, 1),
					silent = this.context.createGain();
				silent.gain.value = 0;
				const c = {
					key,
					input,
					session,
					signature: this.signature(entries),
					jobs: entries,
					audio: new LiveSpeechAudio(),
					busy: false,
					processor,
					silent,
				};
				this.live.set(id, c);
				processor.onaudioprocess = (e) => {
					if (!this.enabled || this.state?.session !== session || !this.permitted(key, input) || !input.allowed()) {
						c.audio.reset();
						return;
					}
					const samples = e.inputBuffer.getChannelData(0);
					c.audio.append(
						samples,
						this.context.sampleRate,
						Date.now() - (samples.length * 1000) / this.context.sampleRate
					);
				};
				input.source.connect(processor);
				processor.connect(silent);
				silent.connect(this.context.destination);
			}
			const c = this.live.get(id)!;
			if (c.busy) continue;
			const wav = c.audio.take(Date.now());
			if (!wav) continue;
			c.busy = true;
			void ipcRenderer
				.invoke(
					'HERO_SPEECH_LOCAL_TRANSCRIBE',
					session,
					id,
					c.jobs.map((j) => ({ kind: j.kind, request: j.request })),
					Date.now(),
					wav
				)
				.catch(() => {})
				.finally(() => {
					c.busy = false;
				});
		}
	}
	private stopLive(id: number): void {
		const c = this.live.get(id);
		if (!c) return;
		this.live.delete(id);
		c.processor.onaudioprocess = null;
		try {
			c.input.source.disconnect(c.processor);
		} catch {
			/* Source already removed. */
		}
		c.processor.disconnect();
		c.silent.disconnect();
		c.audio.reset();
	}
	private reconcileRecording(jobs: HeroSpeechPlayer[], session: string): void {
		for (const [id, capture] of this.recordings) {
			const job = jobs.find((p) => `${p.playerId}|stone` === id);
			if (!job || capture.session !== session) {
				this.stopRecording(id);
				continue;
			}
			if (job.request !== capture.job.request) {
				capture.recorder = new StonePcm();
				capture.job = job;
				capture.warm.forEach((chunk) => this.appendRecording(capture, chunk.samples, chunk.at));
			} else capture.job = job;
			if (!job.request || job.recordUntil! > Date.now() || this.handled.has(this.jobKey(job))) continue;
			const wav = capture.recorder.wav();
			this.handled.add(this.jobKey(job));
			if (wav)
				void ipcRenderer
					.invoke('VOICE_STONE_LOCAL_TRANSCRIBE', session, job.playerId, job.request, wav)
					.catch(() => {});
		}
		for (const job of jobs) {
			const id = `${job.playerId}|stone`;
			if (this.recordings.has(id)) continue;
			const input = [...this.inputs].find(([key, i]) => i.player === job.playerId && this.permitted(key, i))?.[1];
			if (!input) continue;
			const processor = this.context.createScriptProcessor(2048, 1, 1),
				silent = this.context.createGain(),
				recorder = new StonePcm();
			silent.gain.value = 0;
			const capture = {
				job,
				session,
				input,
				recorder,
				warm: [] as { at: number; samples: Float32Array }[],
				processor,
				silent,
			};
			this.recordings.set(id, capture);
			processor.onaudioprocess = (event) => {
				if (!this.enabled || this.state?.session !== session || !input.allowed()) {
					capture.warm = [];
					return;
				}
				const samples = event.inputBuffer.getChannelData(0),
					at = Date.now() - (samples.length / this.context.sampleRate) * 1000;
				capture.warm.push({ at, samples: samples.slice() });
				capture.warm = capture.warm.filter((chunk) => chunk.at >= at - 1000);
				this.appendRecording(capture, samples, at);
			};
			input.source.connect(processor);
			processor.connect(silent);
			silent.connect(this.context.destination);
		}
	}
	private appendRecording(
		capture: { job: HeroSpeechPlayer; recorder: StonePcm },
		samples: Float32Array,
		at: number
	): void {
		const job = capture.job;
		if (!job.request || !Number.isSafeInteger(job.recordStarted) || this.handled.has(this.jobKey(job))) return;
		capture.recorder.append(
			stoneAudioWindow(samples, this.context.sampleRate, at, job.recordStarted!, job.recordUntil!),
			this.context.sampleRate
		);
	}
	private stopRecording(id: string): void {
		const capture = this.recordings.get(id);
		if (!capture) return;
		this.recordings.delete(id);
		capture.processor.onaudioprocess = null;
		try {
			capture.input.source.disconnect(capture.processor);
		} catch {
			/* Input may already have been removed. */
		}
		capture.processor.disconnect();
		capture.silent.disconnect();
	}
	private async ensureModel(): Promise<void> {
		if (this.model || this.loading || Date.now() < this.retryAt) return;
		this.loading = true;
		try {
			const library = await loadLibrary();
			if (this.disposed || !this.enabled) return;
			const model = await library.createModel(asset('model-ja.tar.gz'), -1);
			if (this.disposed || !this.enabled || !this.needsVosk) {
				model.terminate();
				return;
			}
			this.model = model;
		} catch (error) {
			this.retryAt = Date.now() + 10000;
			console.warn('日本語の音声認識を準備できませんでした。', error);
		} finally {
			this.loading = false;
		}
	}
	private reconcile(jobs: HeroSpeechPlayer[]): void {
		const now = Date.now();
		const active = jobs.filter((p) => p.request > 0 && p.expires > now && !this.handled.has(this.jobKey(p)));
		const groups = new Map<number, HeroSpeechPlayer[]>();
		for (const job of active) groups.set(job.playerId, [...(groups.get(job.playerId) ?? []), job]);
		for (const [id, capture] of this.captures) {
			const current = groups.get(id);
			if (!current || this.signature(current) !== capture.signature) this.stop(id);
			else capture.jobs = current;
		}
		if (!this.model) return;
		for (const [id, entries] of groups) if (!this.captures.has(id)) this.begin(id, entries);
	}
	private jobKey(job: HeroSpeechPlayer): string {
		return `${job.playerId}|${job.kind}|${job.request}`;
	}
	private signature(jobs: HeroSpeechPlayer[]): string {
		return jobs
			.map((p) => `${this.jobKey(p)}|${p.words.join('|')}|${p.maxCharacters ?? ''}`)
			.sort()
			.join(';');
	}
	private begin(player: number, jobs: HeroSpeechPlayer[]): void {
		const found = [...this.inputs].find(
			([key, input]) => input.player === player && this.permitted(key, input) && input.allowed()
		);
		if (!found || !this.model || !this.state) return;
		const [key, input] = found;
		const recognizer = new this.model.KaldiRecognizer(this.context.sampleRate);
		if (jobs.some((job) => job.kind === 'stone')) recognizer.setWords?.(true);
		const processor = this.context.createScriptProcessor(2048, 1, 1);
		const silent = this.context.createGain();
		silent.gain.value = 0;
		const capture: Capture = {
			player,
			key,
			input,
			jobs,
			session: this.state.session,
			signature: this.signature(jobs),
			recognizer,
			processor,
			silent,
			partialAt: 0,
		};
		this.captures.set(player, capture);
		recognizer.on('result', (message) => this.accept(capture, message.result?.text, true, message.result?.result));
		recognizer.on('partialresult', (message) => this.accept(capture, message.result?.partial, false));
		processor.onaudioprocess = (event) => {
			if (!input.allowed()) {
				this.stop(player);
				return;
			}
			if (this.current(capture)) recognizer.acceptWaveform(event.inputBuffer);
		};
		input.source.connect(processor);
		processor.connect(silent);
		silent.connect(this.context.destination);
	}
	private current(capture: Capture): boolean {
		return (
			!this.disposed &&
			this.enabled &&
			this.state?.session === capture.session &&
			this.captures.get(capture.player) === capture &&
			this.permitted(capture.key, capture.input)
		);
	}
	private accept(capture: Capture, text: unknown, final: boolean, tokens?: unknown): void {
		if (!this.current(capture) || !capture.input.allowed()) return;
		for (const job of capture.jobs) this.acceptJob(capture, job, text, final, tokens);
	}
	private acceptJob(capture: Capture, job: HeroSpeechPlayer, text: unknown, final: boolean, tokens?: unknown): void {
		if (job.expires <= Date.now() || this.handled.has(this.jobKey(job))) return;
		if (job.kind === 'stone') {
			const word = recognisedStoneWord(tokens, final, job.maxCharacters);
			if (word) {
				this.handled.add(this.jobKey(job));
				ipcRenderer.send('NOS_HERO_SPEECH_WORD', capture.session, job.playerId, job.request, job.kind, word);
			}
			return;
		}
		const matched =
			job.kind === 'ng' ? heardForbiddenWord(text, job.words, final) : heardTransformation(text, job.words, final);
		if (!matched) {
			if (job.kind === 'hero') capture.partialAt = 0;
			return;
		}
		if (!final && !capture.partialAt) {
			capture.partialAt = performance.now();
			return;
		}
		if (!final && performance.now() - capture.partialAt < 180) return;
		this.handled.add(this.jobKey(job));
		ipcRenderer.send('NOS_HERO_SPEECH_WORD', capture.session, job.playerId, job.request, job.kind);
	}
	private stop(player: number): void {
		const capture = this.captures.get(player);
		if (!capture) return;
		this.captures.delete(player);
		capture.processor.onaudioprocess = null;
		capture.input.source.disconnect(capture.processor);
		capture.processor.disconnect();
		capture.silent.disconnect();
		capture.recognizer.remove();
	}
	private clear(): void {
		for (const id of this.live.keys()) this.stopLive(id);
		this.needsVosk = false;
		this.model?.terminate();
		this.model = undefined;
		for (const id of this.recordings.keys()) this.stopRecording(id);
		for (const player of this.captures.keys()) this.stop(player);
		this.state = undefined;
		this.handled.clear();
	}
	dispose(): void {
		this.disposed = true;
		ipcRenderer.send('NOS_HERO_SPEECH_STOP');
		clearInterval(this.timer);
		this.clear();
		this.inputs.clear();
		this.platforms.clear();
		this.model?.terminate();
		this.model = undefined;
	}
}
