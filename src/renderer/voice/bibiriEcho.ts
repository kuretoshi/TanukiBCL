// Retain a short live audio tail without saving a recording.
export function createBibiriEcho(context: AudioContext, source: AudioNode, destination: AudioNode) {
	const input = context.createGain();
	const delay = context.createDelay(0.5);
	const feedback = context.createGain();
	const output = context.createGain();
	delay.delayTime.value = 0.3;
	feedback.gain.value = 0.56;
	output.gain.value = 0;
	source.connect(input);
	input.connect(delay);
	delay.connect(feedback);
	feedback.connect(delay);
	delay.connect(output);
	output.connect(destination);
	return { input, delay, feedback, output, seen: 0, wasAlive: false, until: 0 };
}

export function updateBibiriEcho(
	effect: ReturnType<typeof createBibiriEcho>,
	active: boolean,
	dead: boolean,
	event: number | undefined,
	now = Date.now()
): void {
	const time = effect.output.context.currentTime;
	if (!active) {
		stopBibiriEcho(effect);
		effect.wasAlive = false;
		return;
	}
	if (dead && effect.wasAlive && event && event !== effect.seen && now - event <= 1500 && now >= event - 100) {
		effect.seen = event;
		effect.until = time + 2.4;
		effect.input.gain.value = 0;
		effect.output.gain.cancelScheduledValues(time);
		effect.output.gain.setValueAtTime(0.65, time);
		effect.output.gain.exponentialRampToValueAtTime(0.001, effect.until);
		effect.output.gain.setValueAtTime(0, effect.until);
	}
	if (!dead) effect.wasAlive = true;
	if (dead) effect.input.gain.value = 0;
	else if (effect.until <= time) effect.input.gain.value = 1;
}

export function stopBibiriEcho(effect: ReturnType<typeof createBibiriEcho>): void {
	const time = effect.output.context.currentTime;
	effect.output.gain.cancelScheduledValues(time);
	effect.output.gain.setValueAtTime(0, time);
	effect.input.gain.value = 0;
	effect.until = 0;
}

export function disconnectBibiriEcho(effect: ReturnType<typeof createBibiriEcho>): void {
	for (const node of [effect.input, effect.delay, effect.feedback, effect.output]) node.disconnect();
}
