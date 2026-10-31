const targets = new WeakMap<AudioParam, number>();

/** Smooth changes to an existing effect without restarting the ramp for each game snapshot. */
export function setEffectGain(node: GainNode, value: number): void {
	const parameter = node.gain;
	const previous = targets.get(parameter);
	if (previous === value) return;
	targets.set(parameter, value);
	if (previous === undefined) parameter.value = value;
	else {
		const now = node.context.currentTime;
		parameter.cancelScheduledValues(now);
		parameter.setTargetAtTime(value, now, 0.01);
	}
}
