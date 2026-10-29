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

type Message = { result?: { text?: string; partial?: string } };
interface Recognizer {
	on(event: string, callback: (message: Message) => void): void;
	acceptWaveform(buffer: AudioBuffer): void;
	remove(): void;
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
		for (const [player, capture] of this.captures) if (capture.key === key) this.stop(player);
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
		const jobs = this.selected(state);
		if (jobs.length) void this.ensureModel();
		if (this.model) ipcRenderer.send('NOS_HERO_SPEECH_READY', state.session, [...new Set(jobs.map((p) => p.playerId))]);
		this.reconcile(jobs);
	}
	private async ensureModel(): Promise<void> {
		if (this.model || this.loading || Date.now() < this.retryAt) return;
		this.loading = true;
		try {
			const library = await loadLibrary();
			if (this.disposed || !this.enabled) return;
			const model = await library.createModel(asset('model-ja.tar.gz'), -1);
			if (this.disposed || !this.enabled) {
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
			.map((p) => `${this.jobKey(p)}|${p.words.join('|')}`)
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
		recognizer.on('result', (message) => this.accept(capture, message.result?.text, true));
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
	private accept(capture: Capture, text: unknown, final: boolean): void {
		if (!this.current(capture) || !capture.input.allowed()) return;
		for (const job of capture.jobs) this.acceptJob(capture, job, text, final);
	}
	private acceptJob(capture: Capture, job: HeroSpeechPlayer, text: unknown, final: boolean): void {
		if (job.expires <= Date.now() || this.handled.has(this.jobKey(job))) return;
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
		for (const player of this.captures.keys()) this.stop(player);
		this.state = undefined;
		this.handled.clear();
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
		this.clear();
		this.inputs.clear();
		this.platforms.clear();
		this.model?.terminate();
		this.model = undefined;
	}
}
