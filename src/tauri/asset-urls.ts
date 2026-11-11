// Runtime game frames contain URLs created outside Vite's source transform.
// Keep the wire format intact and adapt those URLs only inside WebView views.
export function normalizeAssetUrls<T>(value: T): T {
	if (typeof value === 'string')
		return value.replace(
			/^(nos-cosmetic|snr-cosmetic):\/\/(?=(?:image|hat-front|hat-back|visor|skin)\/)/,
			'https://$1.localhost/'
		) as T;
	if (Array.isArray(value)) {
		const mapped = value.map(normalizeAssetUrls);
		return (mapped.some((v, i) => v !== value[i]) ? mapped : value) as T;
	}
	if (value && typeof value === 'object') {
		let changed = false;
		const mapped = Object.fromEntries(
			Object.entries(value).map(([key, v]) => {
				const next = normalizeAssetUrls(v);
				changed ||= next !== v;
				return [key, next];
			})
		);
		return (changed ? mapped : value) as T;
	}
	return value;
}
