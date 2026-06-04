export function isLiteRuntime(): boolean {
	const search =
		typeof window !== 'undefined' && window.location
			? new URLSearchParams(window.location.search.substring(1)).get('lite')
			: null;

	return (
		search === '1' ||
		process.env.BETTERCREWLINK_LITE === '1' ||
		/lite/i.test(process.execPath)
	);
}

export function getVariantStoreName(name = 'config'): string {
	return isLiteRuntime() ? `${name}-lite` : name;
}
