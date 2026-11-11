import { invoke } from '@tauri-apps/api/core';

// Enabled only by an explicit local lab launch. Uses the actual release
// controller, microphone capture, spatial rules and WebRTC implementation.
export async function startVoiceLabObserver() {
	const { voiceController } = await import('../renderer/voice/useVoiceController');
	type ControllerProbe = {
		connection: { peers: Map<string, { getStats(): Promise<RTCStatsReport>; connectionState: string }> };
		audio: { running: boolean };
	};
	const probe = voiceController as unknown as ControllerProbe;
	async function sample() {
		try {
			const snapshot = voiceController.getSnapshot();
			const metrics = {
				sentPackets: 0,
				receivedPackets: 0,
				bytesSent: 0,
				bytesReceived: 0,
				totalSamplesReceived: 0,
				concealedSamples: 0,
			};
			let peers = 0;
			for (const peer of probe.connection.peers.values()) {
				if (peer.connectionState === 'connected') peers++;
				for (const stat of (await peer.getStats()).values()) {
					if (stat.kind !== 'audio') continue;
					if (stat.type === 'outbound-rtp') {
						metrics.sentPackets += stat.packetsSent ?? 0;
						metrics.bytesSent += stat.bytesSent ?? 0;
					}
					if (stat.type === 'inbound-rtp') {
						metrics.receivedPackets += stat.packetsReceived ?? 0;
						metrics.bytesReceived += stat.bytesReceived ?? 0;
						metrics.totalSamplesReceived += stat.totalSamplesReceived ?? 0;
						metrics.concealedSamples += stat.concealedSamples ?? 0;
					}
				}
			}
			await invoke('voice_lab', {
				action: 'report',
				value: {
					connected: snapshot.connected,
					audioReady: probe.audio.running,
					peers,
					hasError: !!snapshot.error,
					muted: snapshot.muted,
					deafened: snapshot.deafened,
					metrics,
				},
			});
		} catch {
			/* A peer can disappear during getStats; retry next sample. */
		}
		window.setTimeout(() => void sample(), 1000);
	}
	await sample();
}
