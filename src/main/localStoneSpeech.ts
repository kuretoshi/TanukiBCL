import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validStoneWord } from '../common/VoiceStoneSpeech';
import { validStoneWav } from './voiceStoneAudio';

export function localSpeechRoot(): string {
	return join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'Speech', 'sherpa-2.0.2');
}
let error = '';
export function localSpeechStatus(): { available: boolean; enabled: boolean; error: string } {
	const root = localSpeechRoot();
	const available =
		!!process.env.LOCALAPPDATA &&
		[
			'runtime/TanukiSpeechWorker.exe',
			'runtime/sherpa-onnx-c-api.dll',
			'runtime/onnxruntime.dll',
			'sensevoice/model.int8.onnx',
			'sensevoice/tokens.txt',
			'silero_vad.onnx',
		].every((p) => existsSync(join(root, p)));
	let enabled = true;
	try {
		enabled = JSON.parse(readFileSync(join(root, 'preferences.json'), 'utf8')).enabled !== false;
	} catch {
		/* Use the shared model by default when its files are available. */
	}
	return { available, enabled: available && enabled, error };
}
export function setLocalSpeech(enabled: unknown): boolean {
	if (typeof enabled !== 'boolean' || !localSpeechStatus().available) return false;
	writeFileSync(join(localSpeechRoot(), 'preferences.json'), JSON.stringify({ enabled }));
	error = '';
	return true;
}
class LocalStoneWorker {
	private child?: ChildProcessWithoutNullStreams;
	private buffer = '';
	private lastUsed = 0;
	private pending = new Map<
		string,
		{ resolve: (word?: string) => void; timer: ReturnType<typeof setTimeout>; maximum: number }
	>();
	private start(): void {
		if (this.child) return;
		const root = localSpeechRoot();
		const child = spawn(join(root, 'runtime/TanukiSpeechWorker.exe'), [root], { windowsHide: true, stdio: 'pipe' });
		this.child = child;
		child.stderr.resume(); // No transcripts/audio are logged.
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (data: string) => this.receive(child, data));
		child.on('error', () => this.stop(child));
		child.on('exit', () => this.stop(child));
	}
	private receive(child: ChildProcessWithoutNullStreams, data: string): void {
		if (child !== this.child) return;
		this.buffer += data;
		if (Buffer.byteLength(this.buffer) > 32768) {
			this.stop(child);
			return;
		}
		let end: number;
		while ((end = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			this.accept(line);
		}
	}
	private accept(line: string): void {
		try {
			const result = JSON.parse(line),
				request = this.pending.get(result.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(result.id);
			error = result.error ? '高精度ローカル認識に失敗しました。モデルを確認してください。' : '';
			request.resolve(validStoneWord(result.word, request.maximum) ? result.word : undefined);
		} catch {
			/* Ignore native library diagnostic lines. */
		}
	}
	async transcribe(wav: Uint8Array, maximum: number, signal: AbortSignal): Promise<string | undefined> {
		if (!localSpeechStatus().enabled || !validStoneWav(wav) || signal.aborted || this.pending.size >= 4) return;
		this.lastUsed = Date.now();
		this.start();
		const child = this.child!,
			id = randomUUID();
		return new Promise((resolve) => {
			const finish = (word?: string) => {
				signal.removeEventListener('abort', cancel);
				resolve(word);
			};
			const cancel = () => {
				const p = this.pending.get(id);
				if (p) clearTimeout(p.timer);
				this.pending.delete(id);
				if (this.pending.size === 0) this.stop(child);
				finish();
			};
			const timer = setTimeout(() => {
				error = '高精度ローカル認識が時間内に完了しませんでした。';
				this.stop(child);
			}, 18000);
			this.pending.set(id, { resolve: finish, timer, maximum });
			signal.addEventListener('abort', cancel, { once: true });
			child.stdin.write(JSON.stringify({ id, maximum, wav: Buffer.from(wav).toString('base64') }) + '\n', (err) => {
				if (err) this.stop(child);
			});
		});
	}
	private stop(child: ChildProcessWithoutNullStreams): void {
		if (child !== this.child) return;
		this.child = undefined;
		this.buffer = '';
		child.kill();
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.resolve();
		}
		this.pending.clear();
	}
	idle(): void {
		if (this.pending.size === 0 && Date.now() - this.lastUsed > 30000) this.close();
	}
	close(): void {
		if (this.child) this.stop(this.child);
	}
}
export const localStoneWorker = new LocalStoneWorker();
