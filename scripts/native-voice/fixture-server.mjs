import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function startFixture({
	directory,
	room: allowedRoom = 'RUSTVOICE',
	hostClientId = 1,
	simulateMobile = false,
} = {}) {
	let url = '';
	const http = createServer(async (req, res) => {
		try {
			if (directory && req.url === '/browser.js') {
				res.setHeader('content-type', 'application/javascript');
				res.end(await readFile(join(directory, 'browser.js')));
				return;
			}
			if (directory && req.url === '/browser.html') {
				res.setHeader('content-type', 'text/html');
				res.end(
					`<!doctype html><meta charset="utf-8"><title>Native voice fixture</title><script>window.voiceFixture={server:${JSON.stringify(url)},report:value=>fetch('/browser-report',{method:'POST',body:JSON.stringify(value)})}</script><script type="module" src="/browser.js"></script>`
				);
				return;
			}
			if (directory && req.url === '/browser-report' && req.method === 'POST') {
				let body = '';
				for await (const chunk of req) {
					body += chunk;
					if (body.length > 16384) {
						res.writeHead(413).end();
						return;
					}
				}
				const report = JSON.parse(body);
				await writeFile(join(directory, 'browser-result.json'), JSON.stringify(report));
				res.end('ok');
				return;
			}
			res.writeHead(404).end();
		} catch {
			res.writeHead(500).end();
		}
	});
	const io = new Server(http, { transports: ['websocket'], maxHttpBufferSize: 1024 * 1024 });
	const clients = new Map();
	const counters = { joins: 0, signals: 0, offers: 0, answers: 0, candidates: 0 };
	const features = {
		mobileBeacons: 0,
		mobileFrames: 0,
		obsFrames: 0,
		publicLobbies: 0,
		gameInfo: 0,
		vadEvents: 0,
		publicEnabled: false,
		obsHasPrivateFields: false,
		mobileLobbyMatches: false,
		appVersion: '',
	};
	io.on('connection', (socket) => {
		socket.emit('clientPeerConfig', { forceRelayOnly: false, iceServers: [] });
		const leave = () => {
			const room = socket.data.room;
			clients.delete(socket.id);
			if (room) {
				socket.leave(room);
				socket.data.room = undefined;
				io.to(room).emit('setClients', Object.fromEntries(clients));
			}
		};
		socket.on('id', (playerId, clientId) => (socket.data.client = { playerId, clientId }));
		socket.on('join', (room, playerId, clientId) => {
			if (room !== allowedRoom) return;
			socket.data.room = room;
			socket.data.client = { playerId, clientId };
			clients.set(socket.id, socket.data.client);
			socket.join(room);
			socket.emit('setHost', hostClientId);
			socket.emit('setClients', Object.fromEntries(clients));
			socket.to(room).emit('join', socket.id, socket.data.client);
			counters.joins++;
		});
		socket.on('signal', ({ to, data }) => {
			if (!clients.has(socket.id)) return;
			if (to === allowedRoom + '_mobile') {
				if (data.mobileHostInfo) {
					features.mobileBeacons++;
					if (simulateMobile)
						socket.emit('signal', {
							from: 'fixture-mobile',
							data: { mobilePlayerInfo: { code: allowedRoom, askingForHost: true } },
						});
				}
				if (data.gameState) {
					features.mobileFrames++;
					features.mobileLobbyMatches = data.gameState.lobbyCode === allowedRoom;
				}
				return;
			}
			if (typeof to === 'string' && to.length === 9 && data.overlayState) {
				features.obsFrames++;
				features.obsHasPrivateFields ||= data.overlayState.players.some(
					(p) => 'ptr' in p || 'isImpostor' in p || 'playerUid' in p
				);
				return;
			}
			if (!clients.has(to)) return;
			counters.signals++;
			if (data.type === 'offer') counters.offers++;
			if (data.type === 'answer') counters.answers++;
			if (data.type === 'candidate') counters.candidates++;
			io.to(to).emit('signal', { from: socket.id, data, client: socket.data.client });
		});
		socket.on('VAD', (activity) => {
			if (!clients.has(socket.id) || typeof activity !== 'boolean') return;
			features.vadEvents++;
			socket.to(socket.data.room).emit('VAD', { activity, client: socket.data.client, socketId: socket.id });
		});
		socket.on('lobby', (room, value) => {
			if (room === allowedRoom && socket.data.client?.clientId === hostClientId) {
				features.publicLobbies++;
				features.publicEnabled = value.isPublic === true;
			}
		});
		socket.on('gameinfo', (value) => {
			features.gameInfo++;
			features.appVersion = value.appVersion;
		});
		socket.on('leave', leave);
		socket.on('disconnect', leave);
	});
	await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
	url = `http://127.0.0.1:${http.address().port}`;
	return {
		url,
		counters,
		features,
		close: () => new Promise((resolve) => io.close(resolve)),
	};
}

export function gameState(clientId = 1) {
	return {
		mod: 'NONE',
		gameState: 1,
		lobbyCode: 'RUSTVOICE',
		hostId: 1,
		clientId,
		isHost: clientId === 1,
		players: [1, 2].map((id) => ({ id: id - 1, clientId: id, isLocal: id === clientId, x: id - 1, y: 0 })),
	};
}
