/** Restore the untrimmed SNR player canvas after the Unity decoder cuts an atlas sprite. */
export function restoreSnrSpriteCanvas(
	image: { width: number; height: number; rgba: Uint8Array },
	rect: { width: number; height: number },
	offset: { x: number; y: number }
): { width: number; height: number; rgba: Uint8Array } {
	const values = [rect.width, rect.height, offset.x, offset.y];
	if (values.some((value) => !Number.isFinite(value) || Math.abs(value - Math.round(value)) > 0.125))
		throw new Error('Invalid SNR sprite canvas geometry');
	const [width, height, left, bottom] = values.map(Math.round);
	if (
		width <= 0 ||
		height <= 0 ||
		width > 4096 ||
		height > 4096 ||
		left < 0 ||
		bottom < 0 ||
		left + image.width > width ||
		bottom + image.height > height ||
		image.rgba.length !== image.width * image.height * 4
	)
		throw new Error('SNR sprite exceeds its original canvas');
	const rgba = new Uint8Array(width * height * 4);
	const top = height - bottom - image.height;
	for (let row = 0; row < image.height; row++) {
		rgba.set(image.rgba.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((top + row) * width + left) * 4);
	}
	return { width, height, rgba };
}
