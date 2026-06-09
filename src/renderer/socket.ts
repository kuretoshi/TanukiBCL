import io from 'socket.io-client';

const COMPATIBLE_SOCKET_OPTIONS: SocketIOClient.ConnectOpts = {
	transports: ['websocket'],
};

export function connectCompatibleSocket(serverUrl: string): SocketIOClient.Socket {
	return io(serverUrl, COMPATIBLE_SOCKET_OPTIONS);
}
