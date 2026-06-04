if (typeof window !== 'undefined' && window.location) {
	const query = new URLSearchParams(window.location.search.substring(1));

	console.log('HEY');
	const view = query.get('view') || 'app';
	const isLiteApp = query.get('lite') === '1';
	if (view === 'app') {
		import('./App');
	} else if (view === 'lobbies' && !isLiteApp) {
		import('./LobbyBrowser/LobbyBrowserContainer');
	} else {
		import('./Overlay');
	}
}
