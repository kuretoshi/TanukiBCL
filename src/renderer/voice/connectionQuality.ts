export interface ConnectionQuality {
	rttMs: number | null;
	jitterMs: number | null;
	lossPercent: number | null;
}

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Keep counters per RTP stream: packet loss must describe the latest interval,
// not the lifetime of the call. A new stream needs a baseline first.
export class ConnectionQualitySampler {
	private previous = new Map<string, { received: number; lost: number }>();

	read(report: RTCStatsReport): ConnectionQuality {
		let rttMs: number | null = null;
		let jitterMs: number | null = null;
		let received = 0;
		let lost = 0;
		const next = new Map<string, { received: number; lost: number }>();
		report.forEach((stat) => {
			if (stat.type === 'transport' && stat.selectedCandidatePairId) {
				const pair = report.get(stat.selectedCandidatePairId);
				if (pair && valid(pair.currentRoundTripTime)) rttMs = pair.currentRoundTripTime * 1000;
			}
			if (stat.type !== 'inbound-rtp' || (stat.kind ?? stat.mediaType) !== 'audio') return;
			if (valid(stat.jitter)) jitterMs = Math.max(jitterMs ?? 0, stat.jitter * 1000);
			if (!valid(stat.packetsReceived) || !Number.isFinite(stat.packetsLost)) return;
			const current = { received: stat.packetsReceived, lost: stat.packetsLost };
			const previous = this.previous.get(stat.id);
			next.set(stat.id, current);
			if (previous && current.received >= previous.received) {
				received += current.received - previous.received;
				lost += Math.max(0, current.lost - previous.lost);
			}
		});
		this.previous = next;
		return { rttMs, jitterMs, lossPercent: received + lost > 0 ? (lost / (received + lost)) * 100 : null };
	}
}

export function qualityBars(quality?: ConnectionQuality): number {
	if (quality?.rttMs == null) return 0;
	const { rttMs, jitterMs, lossPercent } = quality;
	// UI heuristics, not a measurement of Wi-Fi signal strength.
	if (rttMs >= 300 || (jitterMs ?? 0) >= 60 || (lossPercent ?? 0) >= 5) return 1;
	if (rttMs >= 150 || (jitterMs ?? 0) >= 30 || (lossPercent ?? 0) >= 2) return 2;
	return 3;
}
