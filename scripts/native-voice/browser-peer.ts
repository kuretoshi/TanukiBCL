// Real Chromium WebRTC interoperability fixture. Uses the release peer class,
// a generated test tone and an inaudible analysis sink; never opens a microphone.
import io from 'socket.io-client';
import PeerConnection, { type SignalData } from '../../src/renderer/lib/PeerConnection';

declare global {
	interface Window {
		voiceFixture: { server: string; report(value: unknown): void };
	}
}
const context = new AudioContext({ sampleRate: 48000 });
await context.resume();
const tone = context.createOscillator();
tone.frequency.value = 660;
const level = context.createGain();
level.gain.value = 0.05;
const destination = context.createMediaStreamDestination();
tone.connect(level).connect(destination);
tone.start();
const socket = io(window.voiceFixture.server, { transports: ['websocket'] });
let peer: PeerConnection | undefined;
let generation = '';
let peerId = '';
let analyser: AnalyserNode | undefined;
let energy = 0;
let packetsReceived = 0;
let packetsSent = 0;
let dataMessages = 0;
let failure = '';
let samples = 0;
let remoteElement: HTMLAudioElement | undefined;
let inboundStats: Record<string, unknown> = {};

function create(id: string, initiator: boolean, connectionId: string) {
	peer?.destroy();
	peerId = id;
	generation = connectionId;
	const connection = new PeerConnection({ initiator, stream: destination.stream, config: { iceServers: [] } });
	peer = connection;
	connection.on('signal', (data) => socket.emit('signal', { to: id, data: { ...data, connectionId } }));
	connection.on('error', (error) => (failure = String(error)));
	connection.on('connect', () => {
		connection.send(JSON.stringify({ version: '3.2.62' }));
	});
	connection.on('data', () => dataMessages++);
	connection.on('stream', (stream) => {
		remoteElement = new Audio();
		remoteElement.srcObject = stream;
		remoteElement.volume = 0;
		void remoteElement.play().catch((error) => (failure = String(error)));
		analyser = context.createAnalyser();
		analyser.fftSize = 2048;
		const silent = context.createGain();
		silent.gain.value = 0;
		context.createMediaStreamSource(stream).connect(analyser).connect(silent).connect(context.destination);
	});
	return connection;
}
socket.on('connect', () => {
	socket.emit('id', 1, 2, '', '', '');
	socket.emit('join', 'RUSTVOICE', 1, 2, false);
});
socket.on('join', (id: string) => {
	if (!peer) create(id, true, 'browser-fixture');
});
socket.on('signal', async ({ from, data }: { from: string; data: SignalData }) => {
	if (data.type === 'offer') {
		if (peer?.initiator && peer.connectionState !== 'connected' && socket.id! < from) return;
		create(from, false, data.connectionId ?? '');
	}
	if (peer && from === peerId && (data.connectionId === undefined || data.connectionId === generation))
		await peer.signal(data);
});
window.setInterval(async () => {
	if (analyser) {
		const data = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(data);
		energy += data.reduce((sum, sample) => sum + sample * sample, 0);
		samples += data.length;
	}
	if (peer) {
		try {
			for (const stat of (await peer.getStats()).values()) {
				if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
					packetsReceived = stat.packetsReceived ?? 0;
					inboundStats = {
						totalAudioEnergy: stat.totalAudioEnergy,
						totalSamplesReceived: stat.totalSamplesReceived,
						concealedSamples: stat.concealedSamples,
						jitterBufferEmittedCount: stat.jitterBufferEmittedCount,
						audioLevel: stat.audioLevel,
					};
				}
				if (stat.type === 'outbound-rtp' && stat.kind === 'audio') packetsSent = stat.packetsSent ?? 0;
			}
		} catch {
			/* A peer can close during getStats. */
		}
	}
	window.voiceFixture.report({
		connected: peer?.connectionState === 'connected',
		packetsReceived,
		packetsSent,
		pcmEnergy: energy,
		samples,
		dataMessages,
		contextState: context.state,
		inboundStats,
		error: failure,
	});
}, 500);
