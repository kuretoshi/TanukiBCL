// Node globals required at runtime by browser-bundled deps
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
if (typeof globalThis.process === 'undefined') {
	globalThis.process = {
		env: {},
		nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
	} as unknown as NodeJS.Process;
}

if (typeof window !== 'undefined' && window.location) {
	const query = new URLSearchParams(window.location.search.substring(1));

	const view = query.get('view') || 'app';
	switch (view) {
		case 'app':
			void import('./views/App');
			break;
		case 'lobbies':
			void import('./views/LobbyBrowser/LobbyBrowserContainer');
			break;
		case 'debug':
			void import('./views/DebugWindow');
			break;
		case 'inquiry':
			void import('./views/InquiryWindow');
			break;
		case 'settings':
			void import('./views/SettingsWindow');
			break;
		default:
			void import('./views/Overlay');
	}
}
