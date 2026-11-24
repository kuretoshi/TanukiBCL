/** Retry only local SNR sprites, without retaining detached avatars or retrying forever. */
export function retrySnrImage(image: HTMLImageElement): void {
	if (!image.src.startsWith('snr-cosmetic:') || image.dataset.snrRetryPending) return;
	const attempt = Number(image.dataset.snrRetries ?? 0);
	if (attempt >= 2) return;
	const source = image.src;
	image.dataset.snrRetries = String(attempt + 1);
	image.dataset.snrRetryPending = 'true';
	setTimeout(
		() => {
			delete image.dataset.snrRetryPending;
			if (!image.isConnected || image.src !== source || image.naturalWidth > 0) return;
			const url = new URL(source);
			url.searchParams.set('snr_retry', String(attempt + 1));
			image.src = url.href;
		},
		attempt === 0 ? 250 : 1000
	);
}

export function clearSnrImageRetry(image: HTMLImageElement): void {
	delete image.dataset.snrRetries;
	delete image.dataset.snrRetryPending;
}
