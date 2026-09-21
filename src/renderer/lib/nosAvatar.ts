import { useEffect, useState } from 'react';
// @ts-ignore
import playerMask from '../../../static/images/generate/player.png';
// @ts-ignore
import ghostMask from '../../../static/images/generate/ghost.png';

/** Same RGB mask convention as the generated avatars, with a published NoS body color. */
export function tintNosAvatar(data: Uint8ClampedArray, hex: string): void {
	const body = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
	const visor = [154, 202, 213];
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i],
			g = data[i + 1],
			b = data[i + 2];
		const max = Math.max(r, g, b),
			delta = max - Math.min(r, g, b);
		if (max === 0 || delta / max <= 0.4) continue;
		let hue = 60 * (max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta);
		if (hue < 0) hue += 360;
		const near = (target: number, distance: number) => 180 - Math.abs(Math.abs(hue - target) - 180) < distance;
		if (!near(240, 30) && !near(0, 100) && !near(120, 40)) continue;
		// The body mask's solid red is (255,16,16). Remove that cross-channel
		// baseline so a solid body pixel matches the published RGB exactly.
		const green = r > g && r > b ? Math.max(0, (g - r * (16 / 255)) / (1 - 16 / 255)) : g;
		const blue = r > g && r > b ? Math.max(0, (b - r * (16 / 255)) / (1 - 16 / 255)) : b;
		for (let channel = 0; channel < 3; channel++) {
			const shadow = body[channel] * 0.6;
			const painted = shadow * (blue / 255) * (1 - r / 255) + body[channel] * (r / 255);
			data[i + channel] = Math.round(painted * (1 - green / 255) + visor[channel] * (green / 255));
		}
	}
}

const templates = new Map<boolean, Promise<ImageData>>();
const colored = new Map<string, Promise<string>>();

export function getNosAvatar(isAlive: boolean, color: string): Promise<string> {
	const key = `${isAlive}:${color}`;
	const cached = colored.get(key);
	if (cached) return cached;
	if (!templates.has(isAlive)) {
		templates.set(
			isAlive,
			fetch(isAlive ? playerMask : ghostMask)
				.then((response) => response.blob())
				.then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'none' }))
				.then((image) => {
					try {
						const canvas = document.createElement('canvas');
						canvas.width = image.width;
						canvas.height = image.height;
						const context = canvas.getContext('2d');
						if (!context) throw new Error('Canvas unavailable');
						context.drawImage(image, 0, 0);
						return context.getImageData(0, 0, canvas.width, canvas.height);
					} finally {
						image.close();
					}
				})
		);
	}
	const result = templates
		.get(isAlive)!
		.then((template) => {
			const canvas = document.createElement('canvas');
			canvas.width = template.width;
			canvas.height = template.height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Canvas unavailable');
			const image = new ImageData(new Uint8ClampedArray(template.data), template.width, template.height);
			tintNosAvatar(image.data, color);
			context.putImageData(image, 0, 0);
			return canvas.toDataURL('image/png');
		})
		.catch((error) => {
			templates.delete(isAlive);
			colored.delete(key);
			throw error;
		});
	if (colored.size >= 128) colored.delete(colored.keys().next().value!);
	colored.set(key, result);
	return result;
}

export function useNosAvatar(isAlive: boolean, color?: string): string | undefined {
	const [result, setResult] = useState<{ key: string; url: string }>();
	const key = `${isAlive}:${color}`;
	useEffect(() => {
		if (!color) return;
		let active = true;
		void getNosAvatar(isAlive, color)
			.then((url) => {
				if (active) setResult({ key, url });
			})
			.catch(() => {
				/* Keep the ordinary avatar if a template cannot load. */
			});
		return () => {
			active = false;
		};
	}, [isAlive, color, key]);
	return result?.key === key ? result.url : undefined;
}
