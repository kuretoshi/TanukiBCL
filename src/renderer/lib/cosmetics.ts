import { useEffect, useSyncExternalStore } from 'react';
// @ts-ignore
import redAliveimg from '../../../static/images/avatar/placeholder.png'; // @ts-ignore
import rainbowAliveimg from '../../../static/images/avatar/rainbow-alive.png'; // @ts-ignore
import rainbowDeadeimg from '../../../static/images/avatar/rainbow-dead.png';

import { ModsType } from '../../common/Mods';
import { RainbowColorId } from '../../common/playerColors';
export const redAlive = redAliveimg;

export enum cosmeticType {
	base,
	hat,
	hat_back,
	visor,
	skin,
}
interface hatData {
	image: string;
	back_image: string;
	top: string | undefined;
	width: string | undefined;
	left: string | undefined;
	multi_color: boolean | undefined;
	mod: ModsType | undefined;
}
let hatCollection: {
	[mod: string]: {
		defaultWidth: string;
		defaultTop: string;
		defaultLeft: string;
		hats: {
			[id: string]: hatData;
		};
	};
} = {};

export interface HatDementions {
	top: string;
	left: string;
	width: string;
}

// SNR sprites are full-player canvases. Keep hat and visor values separate so
// their position and scale can be tuned independently against the game.
const SNR_HAT_FRONT_DEMENTIONS: HatDementions = { top: '-52%', width: '140%', left: '-18px' };
const SNR_HAT_BACK_DEMENTIONS: HatDementions = { ...SNR_HAT_FRONT_DEMENTIONS };
const SNR_VISOR_DEMENTIONS: HatDementions = { top: '-52%', width: '140%', left: '-18px' };

let requestingHats = false;
export let initializedHats = false;
let hatsRevision = 0;
const hatListeners = new Set<() => void>();

interface SnrCosmeticDefinition {
	name: string;
	package?: string;
	resource?: string;
	backresource?: string;
	adaptive?: boolean;
	IsSNR?: boolean | string;
	isSNR?: boolean | string;
}

const SNR_COSMETICS_RAW = 'https://raw.githubusercontent.com/SuperNewRoles/SuperNewCosmetics/main/';
const snrHatDefinitions: SnrCosmeticDefinition[] = [];
const snrVisorDefinitions: SnrCosmeticDefinition[] = [];
const snrImageSizes = new Map<string, { width: number; height: number }>();
const pendingSnrImageSizes = new Set<string>();

function notifyHatsChanged(): void {
	hatsRevision++;
	hatListeners.forEach((listener) => listener());
}

function loadSnrDefinitions(file: string, property: 'hats' | 'Visors'): Promise<SnrCosmeticDefinition[]> {
	return fetch(`${SNR_COSMETICS_RAW}${file}`)
		.then((response) => {
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return response.text();
		})
		.then((text) => JSON.parse(text.replace(/^\uFEFF/, ''))[property] ?? []);
}

function initializeSnrCosmetics(): void {
	void Promise.all([loadSnrDefinitions('CustomHats.json', 'hats'), loadSnrDefinitions('CustomVisors.json', 'Visors')])
		.then(([hats, visors]) => {
			snrHatDefinitions.splice(0, snrHatDefinitions.length, ...hats);
			snrVisorDefinitions.splice(0, snrVisorDefinitions.length, ...visors);
			notifyHatsChanged();
		})
		.catch((error) => console.error('Failed to load SNR cosmetic definitions', error));
}

export function initializeHats() {
	if (initializedHats || requestingHats) {
		return;
	}
	requestingHats = true;
	fetch(`${HAT_COLLECTION_URL}/hats.json`)
		.then((response) => response.json())
		.then((data) => {
			hatCollection = data;
			initializedHats = true;
			notifyHatsChanged();
		})
		.catch((error) => {
			console.error('Failed to load hats.json', error);
			requestingHats = false;
		});
	initializeSnrCosmetics();
	return undefined;
}

function subscribeToHats(listener: () => void): () => void {
	hatListeners.add(listener);
	return () => {
		hatListeners.delete(listener);
	};
}

function getHatsSnapshot(): number {
	return hatsRevision;
}

export function useHatsLoaded(): number {
	useSyncExternalStore(subscribeToHats, getHatsSnapshot, getHatsSnapshot);
	useEffect(() => {
		initializeHats();
	}, []);
	return initializedHats ? hatsRevision : 0;
}

const HAT_COLLECTION_URL = 'https://cdn.jsdelivr.net/gh/OhMyGuus/BetterCrewLink-Hats@master/'; //'https://raw.githubusercontent.com/OhMyGuus/BetterCrewlink-Hats/master';

function normalizedResourceId(resource = ''): string {
	return resource
		.replace(/<[^>]*>/g, '')
		.replace(/\.png$/i, '')
		.replace(/_(front|idle|back|flip|adaptive|bounce)(_(front|idle|back|flip|adaptive|bounce))*$/i, '')
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase();
}

function findSnrDefinition(id: string, definitions: SnrCosmeticDefinition[]): SnrCosmeticDefinition | undefined {
	const plainId = id.replace(/<[^>]*>/g, '');
	const exact = definitions.find(
		({ name, package: packageName = 'NONE_PACKAGE' }) => plainId === `Modded_${packageName}_${name}`
	);
	if (exact) return exact;
	const normalizedProductId = normalizedResourceId(plainId);
	return definitions.find(({ resource }) => {
		const resourceId = normalizedResourceId(resource);
		return resourceId.length > 0 && normalizedProductId.endsWith(resourceId);
	});
}

function requestSnrImageSize(url: string): void {
	if (snrImageSizes.has(url) || pendingSnrImageSizes.has(url)) return;
	pendingSnrImageSizes.add(url);
	const image = new Image();
	image.onload = () => {
		pendingSnrImageSizes.delete(url);
		snrImageSizes.set(url, { width: image.naturalWidth, height: image.naturalHeight });
		notifyHatsChanged();
	};
	image.onerror = () => pendingSnrImageSizes.delete(url);
	image.src = url;
}

function snrLocalUrl(id: string, type: cosmeticType): string {
	const part =
		type === cosmeticType.hat_back
			? 'hat-back'
			: type === cosmeticType.visor
				? 'visor'
				: type === cosmeticType.skin
					? 'skin'
					: 'hat-front';
	return `snr-cosmetic://${part}/${encodeURIComponent(id)}`;
}

function isSnrLocalAdaptiveHat(id: string): boolean {
	const plainId = id.replace(/<[^>]*>/g, '');
	return plainId.startsWith('Modded_Multiverse Costume SEL_');
}
function getModHat(color: number, id = '', mod: ModsType, back = false) {
	if (!initializedHats) {
		return '';
	}
	const hatBase = getHat(id, mod);
	const hat = back ? hatBase?.back_image : hatBase?.image;
	const multiColor = hatBase?.multi_color;
	if (hat && hatBase) {
		if (!multiColor) return `${HAT_COLLECTION_URL}${hatBase.mod}/${hat}`;
		else
			return `generate:///hat?color=${color}&url=${encodeURIComponent(`${HAT_COLLECTION_URL}${hatBase.mod}/${hat}`)}`;
	}
	return undefined;
}

function getHat(id: string, modType: ModsType): hatData | undefined {
	if (!initializedHats) {
		return undefined;
	}
	for (const mod of ['NONE' as ModsType, modType]) {
		const modHatList = hatCollection[mod];
		const hat = modHatList?.hats[id];
		if (hat) {
			hat.top = hat?.top ?? modHatList?.defaultTop;
			hat.width = hat?.width ?? modHatList?.defaultWidth;
			hat.left = hat?.left ?? modHatList?.defaultLeft;
			hat.mod = mod;
			return hat;
		}
	}
	return undefined;
}

export function getHatDementions(id: string, mod: ModsType, type: cosmeticType = cosmeticType.hat): HatDementions {
	const hat = getHat(id, mod);
	if (!hat && mod === 'SUPER_NEW_ROLES' && id.startsWith('Modded_')) {
		// SNR custom sprites use the same full 300x375 player canvas as the game.
		// The avatar base is slightly wider and starts lower, so align each full
		// canvas independently instead of applying vanilla hat offsets.
		if (type === cosmeticType.visor) {
			const definition = findSnrDefinition(id, snrVisorDefinitions);
			const isSnrLayout = definition?.IsSNR === true || definition?.IsSNR === 'true' || definition?.isSNR === true;
			const url = snrLocalUrl(id, type);
			const size = url ? snrImageSizes.get(url) : undefined;
			if (isSnrLayout && size) {
				// SNRVisorLoadSprite: centered pivot with a fixed 115 pixels-per-unit.
				// Convert that world-space size into the calibrated full-canvas CSS space.
				const naturalWidth = (size.width / (115 * (8 / 3))) * 140;
				// Some legacy Visor_SNR images contain a very large transparent canvas.
				// Keep their aspect ratio, but do not let that canvas exceed the size of
				// a regular full-player SNR cosmetic.
				const width = Math.min(naturalWidth, 140);
				const height = (size.height / size.width) * width;
				return {
					width: `${width}%`,
					left: `${56 - width / 2}px`,
					top: `${22 - height / 2}%`,
				};
			}
			return SNR_VISOR_DEMENTIONS;
		}
		return type === cosmeticType.hat_back ? SNR_HAT_BACK_DEMENTIONS : SNR_HAT_FRONT_DEMENTIONS;
	}
	return {
		top: hat?.top ?? '0',
		width: hat?.width ?? '0',
		left: hat?.left ?? '0',
	};
}

export function getCosmetic(
	color: number,
	isAlive: boolean,
	type: cosmeticType,
	id = '',
	mod: ModsType = 'NONE'
): string {
	if (type === cosmeticType.base) {
		if (color == RainbowColorId) {
			return isAlive ? rainbowAliveimg : rainbowDeadeimg;
		}
		return `static:///generated/${isAlive ? `player` : `ghost`}/${color}.png`;
	} else if (mod === 'SUPER_NEW_ROLES' && id.startsWith('Modded_')) {
		const localCosmetic = snrLocalUrl(id, type);
		if (type === cosmeticType.visor) requestSnrImageSize(localCosmetic);
		const definition =
			type === cosmeticType.skin
				? undefined
				: findSnrDefinition(id, type === cosmeticType.visor ? snrVisorDefinitions : snrHatDefinitions);
		const adaptive =
			definition?.adaptive === true ||
			/_adaptive(?:_|\.)/i.test(definition?.resource ?? '') ||
			((type === cosmeticType.hat || type === cosmeticType.hat_back) && isSnrLocalAdaptiveHat(id));
		return adaptive ? `${localCosmetic}?adaptive=1&color=${color}` : localCosmetic;
	} else {
		const modHat = getModHat(color, id, mod, type === cosmeticType.hat_back);
		if (modHat) return modHat;
	}
	return '';
}
