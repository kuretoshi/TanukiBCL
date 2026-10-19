export interface InterviewState {
	playerId: number;
	started: number;
	seconds: number;
	stopped: number;
	visible: number[];
	playStarted: number;
}

export function validInterview(value: InterviewState, now: number): boolean {
	return (
		!!value &&
		Number.isInteger(value.playerId) &&
		value.playerId >= 0 &&
		value.playerId <= 255 &&
		Number.isSafeInteger(value.started) &&
		value.started > 0 &&
		value.started <= now + 100 &&
		Number.isFinite(value.seconds) &&
		value.seconds >= 1 &&
		value.seconds <= 30 &&
		Number.isSafeInteger(value.stopped) &&
		(value.stopped === 0 ||
			(value.stopped >= value.started && value.stopped <= value.started + value.seconds * 1000)) &&
		Array.isArray(value.visible) &&
		value.visible.length <= 255 &&
		new Set(value.visible).size === value.visible.length &&
		value.visible.every((id) => Number.isInteger(id) && id >= 0 && id <= 255) &&
		Number.isSafeInteger(value.playStarted) &&
		value.playStarted >= 0 &&
		value.playStarted <= now + 100 &&
		(value.playStarted === 0 || (value.stopped > value.started && value.playStarted >= value.stopped))
	);
}
