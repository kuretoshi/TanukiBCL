/** Compare release versions numerically; ignore malformed peer input. */
export function compareAppVersions(left: string, right: string): -1 | 0 | 1 | undefined {
	const parse = (value: string) =>
		/^\d+\.\d+\.\d+$/.test(value) && value.length <= 32 ? value.split('.').map(Number) : undefined;
	const a = parse(left),
		b = parse(right);
	if (!a || !b || !a.every(Number.isSafeInteger) || !b.every(Number.isSafeInteger)) return undefined;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	return 0;
}

/** Notify only the older side of a comparison with the lobby host. */
export function requiredAppVersion(
	local: string,
	host: string | undefined,
	isHost: boolean,
	participants: readonly string[]
): string | undefined {
	const candidates = isHost ? participants : host ? [host] : [];
	return candidates
		.filter((version) => compareAppVersions(local, version) === -1)
		.sort((a, b) => compareAppVersions(b, a) ?? 0)[0];
}

/** Known peers with a different valid release version from this client. */
export function mismatchedAppVersions<T extends { version: string }>(local: string, peers: readonly T[]): T[] {
	return peers.filter((peer) => {
		const comparison = compareAppVersions(local, peer.version);
		return comparison !== undefined && comparison !== 0;
	});
}
