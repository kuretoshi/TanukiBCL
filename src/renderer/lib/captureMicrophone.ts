/** Preserve a selected input when available, but recover when its saved ID becomes stale. */
export async function captureMicrophone(
	constraints: MediaTrackConstraints,
	selectedDeviceId: string | undefined
): Promise<{ stream: MediaStream; usedDefault: boolean }> {
	const deviceId = selectedDeviceId && selectedDeviceId.toLowerCase() !== 'default' ? selectedDeviceId : undefined;
	const audio = { ...constraints, deviceId: deviceId ? { exact: deviceId } : undefined };
	try {
		return { stream: await navigator.mediaDevices.getUserMedia({ video: false, audio }), usedDefault: false };
	} catch (error) {
		const mediaError = error as { name?: string; constraint?: string };
		const unavailable =
			mediaError?.name === 'NotFoundError' ||
			(mediaError?.name === 'OverconstrainedError' && (!mediaError.constraint || mediaError.constraint === 'deviceId'));
		if (!deviceId || !unavailable) throw error;
		const stream = await navigator.mediaDevices.getUserMedia({
			video: false,
			audio: { ...constraints, deviceId: undefined },
		});
		return { stream, usedDefault: true };
	}
}
