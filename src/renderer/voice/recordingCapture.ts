/** Keep PCM callbacks out of the main thread while a recording is idle. */
export function createRecordingCapture(
	context: AudioContext,
	source: AudioNode,
	destination: AudioNode,
	onAudio: (event: AudioProcessingEvent) => void
) {
	let processor: ScriptProcessorNode | undefined;
	let silent: GainNode | undefined;
	let active = false;
	let disposed = false;
	let generation = 0;
	function setActive(next: boolean): void {
		if (disposed || active === next) return;
		active = next;
		const current = ++generation;
		if (next) {
			processor ??= context.createScriptProcessor(2048, 1, 1);
			silent ??= context.createGain();
			silent.gain.value = 0;
			processor.onaudioprocess = (event) => {
				if (active && !disposed && generation === current) onAudio(event);
			};
			source.connect(processor);
			processor.connect(silent);
			silent.connect(destination);
		} else if (processor && silent) {
			processor.onaudioprocess = null;
			try {
				source.disconnect(processor);
			} catch {
				/* The source may already have been removed. */
			}
			processor.disconnect();
			silent.disconnect();
			// A later recording needs fresh buffers, not PCM left in an old processor.
			processor = undefined;
			silent = undefined;
		}
	}
	return {
		setActive,
		disconnect() {
			setActive(false);
			disposed = true;
			processor = undefined;
			silent = undefined;
		},
	};
}
