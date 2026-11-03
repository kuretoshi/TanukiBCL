export function serverDeepLinkFromParams(input) {
	if (typeof input !== 'string' || input.length > 4096 || !['?', '#'].includes(input[0])) return null;
	const params = new URLSearchParams(input.slice(1));
	const keys = [...params.keys()];
	if (
		keys.length < 1 ||
		keys.length > 2 ||
		new Set(keys).size !== keys.length ||
		keys.some((key) => key !== 'url' && key !== 'lite')
	)
		return null;
	if (!params.has('url') || (params.has('lite') && params.get('lite') !== '1')) return null;
	const value = params.get('url');
	if (!value || value.length > 2048 || value !== value.trim()) return null;
	let server;
	try {
		server = new URL(value);
	} catch {
		return null;
	}
	if (
		(server.protocol !== 'http:' && server.protocol !== 'https:') ||
		!server.hostname ||
		server.username ||
		server.password ||
		server.pathname !== '/' ||
		server.search ||
		server.hash
	)
		return null;
	const link = new URL(`${params.has('lite') ? 'tanukibcl-lite' : 'tanukibcl'}://server`);
	link.searchParams.set('url', server.origin);
	const bridgePort = params.has('lite') ? 38385 : 38384;
	return {
		serverUrl: server.origin,
		deepLink: link.toString(),
		bridgeUrl: `http://127.0.0.1:${bridgePort}/invite`,
	};
}

if (typeof document !== 'undefined') {
	const invite = serverDeepLinkFromParams(window.location.search || window.location.hash);
	const message = document.getElementById('message');
	const server = document.getElementById('server');
	const open = document.getElementById('open');
	const hint = document.getElementById('hint');
	if (!invite) {
		message.textContent = 'リンクが正しくありません。共有した人に新しいリンクを送ってもらってください。';
		hint.hidden = true;
	} else {
		message.textContent = 'ベタクルで接続先を確認してください。';
		server.textContent = invite.serverUrl;
		server.hidden = false;
		if (open.tagName === 'BUTTON') {
			open.addEventListener('click', async () => {
				open.disabled = true;
				message.textContent = 'ベタクルに接続しています…';
				try {
					const response = await fetch(invite.bridgeUrl, {
						method: 'POST',
						mode: 'cors',
						targetAddressSpace: 'loopback',
						referrerPolicy: 'no-referrer',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ url: invite.serverUrl }),
						signal: AbortSignal.timeout(5000),
					});
					if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
					message.textContent = 'ベタクルで接続先を確認してください。';
				} catch {
					message.textContent = 'ベタクルに接続できませんでした。アプリを起動し、ブラウザーが求めるローカルネットワークへのアクセスを許可して、もう一度お試しください。';
				} finally {
					open.disabled = false;
				}
			});
		} else {
			open.href = invite.deepLink;
		}
		open.hidden = false;
	}
}
