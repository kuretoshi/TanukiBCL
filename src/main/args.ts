import minimist from 'minimist';

export function getAppArgs(): ReturnType<typeof minimist> {
	const parsed = minimist(process.argv);
	const appArgs = Array.isArray(parsed._) ? parsed._.filter((arg: unknown) => typeof arg === 'string') : [];
	return Object.assign(parsed, minimist(appArgs));
}
