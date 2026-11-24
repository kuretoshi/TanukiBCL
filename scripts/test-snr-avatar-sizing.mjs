// Exercise the shipped Rust/Wasm renderer with synthetic IPC and explicit local PNG fixtures.
// This validates rendering of both cosmetic slots, not live-game acquisition of their IDs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { PNG } from 'pngjs';
import electron from 'electron';

const root = resolve(import.meta.dirname, '..');
const cache = resolve(process.env.SNR_AVATAR_SIZING_CACHE ?? join(root, '.tools/snr-avatar-sizing'));
const ui = resolve(process.env.TANUKI_RUST_UI_DIST ?? join(root, 'out/tauri-rust-ui'));
const wasmPath = join(ui, 'rust-ui/tbcl_rust_ui_bg.wasm');
const wasmSha256 = createHash('sha256')
	.update(await readFile(wasmPath))
	.digest('hex');
const fixtureArgument = process.argv.indexOf('--fixtures');
const recoveryOnly = process.argv.includes('--recovery');
const fixturePath = resolve(
	fixtureArgument >= 0 ? process.argv[fixtureArgument + 1] : join(cache, 'browser-input.json')
);
const input = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixtures = Array.isArray(input) ? input : input.assets;
assert.ok(fixtures?.length >= 2, 'Expected local hat/visor fixtures with beforePath, afterPath, width and height');
const defaults = JSON.parse(await readFile(join(root, 'src-tauri/rust-ui/assets/release-data.json'), 'utf8')).defaults;
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, 'browser-'));
if (dirname(directory) !== cache || !basename(directory).startsWith('browser-'))
	throw Error('Unexpected browser cache path');

function bounds(image) {
	let left = image.width,
		top = image.height,
		right = 0,
		bottom = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if (image.data[(y * image.width + x) * 4 + 3] < 16) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x + 1);
			bottom = Math.max(bottom, y + 1);
		}
	}
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
const loaded = [];
for (const original of fixtures) {
	const fixture = {
		...original,
		width: original.width ?? original.originalWidth,
		height: original.height ?? original.originalHeight,
	};
	const versions = {};
	for (const mode of ['before', 'after']) {
		const file = resolve(fixture[`${mode}Path`]),
			bytes = await readFile(file),
			image = PNG.sync.read(bytes);
		if (mode === 'after') {
			assert.equal(image.width, fixture.width, `${fixture.id}: restored sprite width`);
			assert.equal(image.height, fixture.height, `${fixture.id}: restored sprite height`);
		}
		versions[mode] = {
			file,
			bytes,
			width: image.width,
			height: image.height,
			bounds: bounds(image),
			sha256: createHash('sha256').update(bytes).digest('hex'),
		};
	}
	loaded.push({ ...fixture, ...versions });
}
const hat = loaded.find((row) => row.part === 'hat-front'),
	visor = loaded.find((row) => row.part === 'visor');
assert.ok(hat && visor, 'Fixture manifest needs a front hat and visor');
const body = await readFile(join(root, 'static/images/generate/player.png'));
const requests = [];
const recoveryRequests = new Map();
let mode = 'after';
const server = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/mode') {
		const next = url.searchParams.get('value');
		if (!['before', 'after'].includes(next)) {
			response.writeHead(400).end();
			return;
		}
		mode = next;
		response.end('ok');
		return;
	}
	if (url.pathname === '/') {
		response.setHeader('Content-Type', 'text/html');
		response.end(
			'<!doctype html><html><body><div id="app"></div><script type="module">import init from "/rust-ui/tbcl_rust_ui.js";await init();</script></body></html>'
		);
		return;
	}
	if (url.pathname === '/fixture') {
		response.setHeader('Cache-Control', 'no-store');
		const kind = url.searchParams.get('kind'),
			part = url.searchParams.get('part');
		const recovery = url.searchParams.get('recovery');
		requests.push({ mode, kind, part, id: url.searchParams.get('id'), color: url.searchParams.get('color'), recovery });
		if (recovery) {
			const attempt = (recoveryRequests.get(recovery) ?? 0) + 1;
			recoveryRequests.set(recovery, attempt);
			if (['permanent', 'detached', 'non-snr', 'base'].includes(recovery) || attempt === 1) {
				response.writeHead(404).end();
				return;
			}
		}
		if (kind === 'body') {
			response.setHeader('Content-Type', 'image/png');
			response.end(body);
			return;
		}
		const fixture = part === 'visor' ? visor : part === 'hat-front' ? hat : undefined;
		if (!fixture) {
			response.writeHead(404).end();
			return;
		}
		response.setHeader('Content-Type', 'image/png');
		response.end(fixture[mode].bytes);
		return;
	}
	const file = resolve(ui, '.' + url.pathname);
	if (!file.startsWith(ui + sep)) {
		response.writeHead(404).end();
		return;
	}
	try {
		response.setHeader(
			'Content-Type',
			{ '.wasm': 'application/wasm', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[
				extname(file)
			] ?? 'application/octet-stream'
		);
		response.end(await readFile(file));
	} catch {
		response.writeHead(404).end();
	}
});

function mockBackend(defaults, hatId, visorId, view) {
	const players = Array.from({ length: view === 'overlay' ? 2 : 25 }, (_, i) => ({
		id: i,
		clientId: i + 100,
		isLocal: i === 0,
		name: i === 0 ? 'Synthetic local player' : 'Synthetic player ' + i,
		colorId: 0,
		currentOutfit: 0,
		isDead: false,
		disconnected: false,
		shiftedColor: -1,
		hatId,
		visorId,
		skinId: '',
		snrHat2Id: 'Modded_UIFixture_SecondHat',
		snrVisor2Id: 'Modded_UIFixture_SecondVisor',
	}));
	const game = { mod: 'SUPER_NEW_ROLES', gameState: 1, map: 0, lobbyCode: 'TEST', players, isHost: false };
	const ids = Object.fromEntries(players.map((p) => [p.clientId, 'socket-' + p.clientId]));
	const sockets = Object.fromEntries(players.map((p) => ['socket-' + p.clientId, { clientId: p.clientId }]));
	const voice = {
		status: {
			connected: true,
			talking: false,
			voiceSnapshot: {
				playerSocketIds: ids,
				socketClients: sockets,
				audioConnected: Object.fromEntries(Object.keys(sockets).map((id) => [id, true])),
				otherTalking: {},
				otherDead: {},
				localIsAlive: true,
				impostorRadioClientIds: [],
			},
		},
	};
	const preferences = {
		...defaults,
		appPlayerLayout: 'standard',
		enableOverlay: true,
		overlayPosition: 'left',
		compactOverlay: false,
	};
	const listeners = [];
	globalThis.__snrSizing = {
		emit: (color) => {
			if (Number.isInteger(color)) players.forEach((player) => (player.colorId = color));
			listeners.forEach((cb) => cb({ payload: { channel: 'NOTIFY_GAME_STATE_CHANGED', args: [game] } }));
		},
	};
	globalThis.__TAURI__ = {
		event: {
			listen: async (_, callback) => {
				listeners.push(callback);
				return () => {};
			},
		},
		core: {
			invoke: async (command, args) => {
				if (command === 'native_voice') return args.action === 'status' ? voice : {};
				if (command !== 'ipc') return null;
				switch (args.channel) {
					case 'settings:get':
						return preferences;
					case 'GET_INITIAL_STATE':
						return game;
					case 'native:context':
						return { playerColors: [['#c51111', '#7b0838']] };
					case 'native:cosmetics-catalog':
						return {
							collection: {},
							snrHats: [],
							snrVisors: [{ package: 'UIFixture', name: 'SecondVisor', IsSNR: true }],
						};
					case 'updater:get-state':
						return { state: 'idle' };
					default:
						return null;
				}
			},
		},
	};
}

async function inspectAvatar() {
	const rect = (node) => {
		const r = node.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	};
	const paint =
		globalThis.document.querySelector('.local-avatar .avatar-paint') ??
		globalThis.document.querySelector('.player .avatar-paint');
	if (!paint) return null;
	const required = ['hat-front', 'hat2-front', 'visor', 'visor2'];
	const images = required.map((name) =>
		[...paint.querySelectorAll('img')].find((node) => node.classList.contains(name))
	);
	if (images.some((image) => !image?.complete || image.naturalWidth === 0)) return null;
	const grid = globalThis.document.querySelector('#other-players-grid');
	const gridPaint = grid?.querySelector('.avatar-paint');
	return {
		viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
		paint: rect(paint),
		grid: grid
			? {
					width: grid.clientWidth,
					height: grid.clientHeight,
					size: parseFloat(globalThis.getComputedStyle(grid).getPropertyValue('--avatar-size')),
				}
			: null,
		images: images.map((image, index) => ({
			name: required[index],
			src: image.src,
			width: image.naturalWidth,
			height: image.naturalHeight,
			rect: rect(image),
			style: image.getAttribute('style'),
			scaling: image.hasAttribute('data-snr-scale'),
		})),
		gridPaint: gridPaint ? rect(gridPaint) : null,
		gridImages: gridPaint
			? required.map((name) => {
					const image = [...gridPaint.querySelectorAll('img')].find((node) => node.classList.contains(name));
					return image?.complete && image.naturalWidth
						? { name, src: image.src, width: image.naturalWidth, height: image.naturalHeight, rect: rect(image) }
						: null;
				})
			: [],
	};
}

async function inspectRecovery(origin) {
	const document = globalThis.document;
	const holder = document.createElement('div');
	document.body.append(holder);
	const specs = ['transient', 'scaled', 'permanent', 'detached', 'changed', 'non-snr', 'base'];
	const entries = specs.map((kind) => {
		const template = document.querySelector(`.local-avatar img.${kind === 'scaled' ? 'visor2' : 'hat-front'}`);
		const image = template.cloneNode();
		const originalStyle = image.getAttribute('style');
		let errors = 0;
		image.addEventListener('error', () => errors++);
		const url = new globalThis.URL(image.src);
		url.searchParams.set('recovery', kind);
		if (kind === 'non-snr' || kind === 'base') {
			url.href = `${origin}/fixture?kind=cosmetic&part=hat-front&id=unrelated&recovery=${kind}`;
			if (kind === 'base') image.className = 'base';
		}
		image.src = url.href;
		holder.append(image);
		if (kind === 'detached') globalThis.setTimeout(() => image.remove(), 100);
		if (kind === 'changed')
			globalThis.setTimeout(() => {
				const next = new globalThis.URL(image.src);
				next.searchParams.delete('recovery');
				next.searchParams.set('color', '6');
				image.src = next.href;
			}, 100);
		return { kind, image, originalStyle, errors: () => errors };
	});
	const snapshot = () =>
		entries.map(({ kind, image, originalStyle, errors }) => ({
			kind,
			originalStyle,
			style: image.getAttribute('style'),
			src: image.src,
			width: image.naturalWidth,
			display: globalThis.getComputedStyle(image).display,
			connected: image.isConnected,
			errors: errors(),
			retries: image.getAttribute('data-snr-retries'),
			savedStyle: image.getAttribute('data-snr-error-style'),
		}));
	const sleep = (ms) => new Promise((done) => globalThis.setTimeout(done, ms));
	await sleep(80);
	const failed = snapshot();
	await sleep(1700);
	const settled = snapshot();
	await sleep(1300);
	const stable = snapshot();
	holder.remove();
	return { failed, settled, stable };
}

function verifyRecovery(row) {
	for (const image of row.failed) assert.ok(image.errors >= 1, `${image.kind}: initial image error was exercised`);
	for (const kind of ['transient', 'scaled', 'changed']) {
		const image = row.stable.find((image) => image.kind === kind);
		assert.ok(image.width > 0, `${kind}: successfully decoded after the initial error`);
		assert.notEqual(image.display, 'none', `${kind}: recovered image is visible`);
		assert.equal(image.style, image.originalStyle, `${kind}: original inline style restored`);
		assert.equal(image.savedStyle, null, `${kind}: recovery marker cleared`);
		assert.equal(image.retries, null, `${kind}: retry counter cleared`);
	}
	assert.equal(recoveryRequests.get('transient'), 2);
	assert.equal(recoveryRequests.get('scaled'), 2);
	assert.equal(recoveryRequests.get('permanent'), 3, 'Permanent missing image stops after two retries');
	assert.equal(recoveryRequests.get('detached'), 1, 'Detached image does not retry');
	assert.equal(recoveryRequests.get('changed'), 1, 'Changed source skips its stale pending retry');
	assert.equal(recoveryRequests.get('non-snr'), 1, 'Unrelated image does not retry');
	assert.equal(recoveryRequests.get('base'), 1, 'Base image keeps its existing single fallback');
	const permanent = row.stable.find((image) => image.kind === 'permanent');
	assert.equal(permanent.width, 0);
	assert.equal(permanent.display, 'none');
	assert.equal(permanent.errors, 3);
	assert.deepEqual(row.stable, row.settled, 'No further request or style change after the retry budget');
	assert.ok(row.stable.find((image) => image.kind === 'base').width > 0, 'Base image fallback still decodes');
}

function verifySizing(rows) {
	for (const row of rows) {
		for (const image of [...row.images, ...row.gridImages])
			assert.equal(new URL(image.src).searchParams.get('color'), '0', `${image.name}: initial color query`);
		for (const image of [...row.colorChanged.images, ...row.colorChanged.gridImages])
			assert.equal(new URL(image.src).searchParams.get('color'), '6', `${image.name}: updated color query`);
		assert.deepEqual(
			row.colorChanged.images.map(({ src: _source, ...image }) => image),
			row.images.map(({ src: _source, ...image }) => image),
			'Changing color preserves natural dimensions and IsSNR load scaling'
		);
	}
	for (const row of rows.filter((row) => row.mode === 'after')) {
		for (const image of [...row.images, ...row.gridImages]) {
			const fixture = image.name.includes('visor') ? visor : hat;
			assert.equal(image.width, fixture.width);
			assert.equal(image.height, fixture.height);
		}
		if (row.scenario !== 'overlay') assert.equal(Math.round(row.paint.width), 80, 'local avatar remains80px');
		const scaled = row.images.find((image) => image.name === 'visor2');
		assert.equal(scaled.scaling, true, 'second visor exercises the real IsSNR image-load hook');
		const width = Number(/width:([0-9.]+)%/.exec(scaled.style)?.[1]);
		assert.ok(
			Math.abs(width - Math.min((visor.width / (115 * (8 / 3))) * 140, 140)) < 0.01,
			'IsSNR image-load hook uses the decoded canvas size'
		);
	}
	for (const selectedMode of ['before', 'after']) {
		for (const id of [hat.id, visor.id, 'Modded_UIFixture_SecondHat', 'Modded_UIFixture_SecondVisor'])
			assert.ok(
				requests.some((request) => request.mode === selectedMode && request.id === id),
				`${selectedMode}: requested cosmetic ${id}`
			);
	}
}

const runner = join(directory, 'runner.cjs'),
	preload = join(directory, 'preload.cjs');
const resultPath = join(cache, recoveryOnly ? 'recovery-result.json' : 'browser-result.json');
try {
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const origin = 'http://127.0.0.1:' + server.address().port;
	await writeFile(
		preload,
		`(${mockBackend.toString()})(${JSON.stringify(defaults)},${JSON.stringify(hat.id)},${JSON.stringify(visor.id)},new URL(location.href).searchParams.get('view'));`
	);
	await writeFile(
		runner,
		`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function read(window){for(let i=0;i<100;i++){const state=await window.webContents.executeJavaScript('('+${JSON.stringify(inspectAvatar.toString())}+')()');if(state&&!state.gridImages.some(i=>i===null))return state;await sleep(30);}throw Error('Rust UI cosmetic images did not decode');}
app.whenReady().then(async()=>{try{const rows=[];
for(const mode of ${JSON.stringify(recoveryOnly ? ['after'] : ['before', 'after'])})for(const scenario of ${JSON.stringify(recoveryOnly ? ['recovery'] : ['grid40', 'grid60', 'overlay'])}){
 const response=await fetch(${JSON.stringify(origin)}+'/mode?value='+mode);if(!response.ok)throw Error('Cannot select fixture mode');
 const size=scenario==='grid60'?60:40,width=scenario==='overlay'?600:5*(size+6)+56;
 const window=new BrowserWindow({show:false,frame:false,width,height:scenario==='overlay'?700:600,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:false,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
 window.webContents.session.webRequest.onBeforeRequest((request,done)=>{
  if(request.url.startsWith(${JSON.stringify(origin + '/')} )||request.url.startsWith('data:'))return done({});
  const url=new URL(request.url);
  if(url.hostname==='snr-cosmetic.localhost'){const[part,id]=url.pathname.slice(1).split('/');return done({redirectURL:${JSON.stringify(origin)}+'/fixture?kind=cosmetic&part='+encodeURIComponent(part)+'&id='+id+'&'+url.searchParams.toString()});}
  if(url.hostname==='static.localhost')return done({redirectURL:${JSON.stringify(origin)}+'/fixture?kind=body'});
  done({cancel:true});
 });
 await window.loadURL(${JSON.stringify(origin)}+'/?view='+(scenario==='overlay'?'overlay':'app')+'&version=fixture');
 let state=await read(window);
 if(scenario==='recovery'){rows.push(await window.webContents.executeJavaScript('('+${JSON.stringify(inspectRecovery.toString())}+')('+JSON.stringify(${JSON.stringify(origin)})+')'));window.destroy();continue;}
 if(state.grid){
  const target=5*(size+6)+32;
  for(let attempt=0;attempt<4&&Math.abs(state.grid.height-target)>1;attempt++){
   window.setContentSize(width,Math.max(300,Math.round(state.viewport.height+target-state.grid.height)));
   await sleep(500);state=await read(window);
  }
 }
 await sleep(350);state=await read(window);
 if(scenario!=='overlay'&&state.grid.size!==size)throw Error('Expected grid '+size+', got '+state.grid.size+' at '+JSON.stringify(state.viewport));
 const row={mode,scenario,...state};rows.push(row);
 await sleep(120);await window.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
 fs.writeFileSync(${JSON.stringify(cache)}+'/'+mode+'-'+scenario+'.png',(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript('__snrSizing.emit(6)');await sleep(400);row.colorChanged=await read(window);window.destroy();
}
fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(rows,null,2));app.exit(0);
}catch(error){console.error(error.stack||error);app.exit(1);}});`
	);
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const child = spawn(electron, [runner], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let logs = '';
	child.stdout.on('data', (chunk) => (logs += chunk));
	child.stderr.on('data', (chunk) => (logs += chunk));
	const timeout = setTimeout(() => child.kill(), 60000);
	const code = await new Promise((done) => child.on('close', done));
	clearTimeout(timeout);
	assert.equal(code, 0, logs);
	const rows = JSON.parse(await readFile(resultPath, 'utf8'));
	const proof = {
		wasmSha256,
		limitations: ['Synthetic IPC supplies second-slot IDs; this does not test live-game slot acquisition'],
		fixtures: loaded.map(({ before, after, ...row }) => ({
			...row,
			before: { ...before, bytes: undefined },
			after: { ...after, bytes: undefined },
		})),
		requests,
		rows,
	};
	await writeFile(resultPath, JSON.stringify(proof, null, 2));
	assert.equal(
		createHash('sha256')
			.update(await readFile(wasmPath))
			.digest('hex'),
		wasmSha256,
		'Rust UI module must remain unchanged during the browser run'
	);
	if (recoveryOnly) {
		verifyRecovery(rows[0]);
		console.log(
			`PASS real Rust/Wasm SNR image recovery: transient, scaled, permanent, detached and changed sources; ${resultPath}`
		);
	} else {
		verifySizing(rows);
		console.log(
			`PASS real Rust/Wasm SNR sizing: before/after local80, grid40/60, overlay and decoded second slots; ${resultPath}`
		);
	}
} finally {
	await new Promise((done) => server.close(done));
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
