import { useEffect, useState } from 'react';

/** A missing mask must leave the normal crewmate visible. */
export function useNosBodyMask(url: string | undefined): string | undefined {
	const [loaded, setLoaded] = useState<string>();
	useEffect(() => {
		setLoaded(undefined);
		if (!url) return;
		const image = new Image();
		let active = true;
		image.onload = () => {
			if (active) setLoaded(url);
		};
		image.onerror = () => {
			if (active) setLoaded(undefined);
		};
		image.src = url;
		return () => {
			active = false;
			image.onload = null;
			image.onerror = null;
		};
	}, [url]);
	return loaded === url ? loaded : undefined;
}
