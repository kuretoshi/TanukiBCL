const minimist = require('minimist'); // eslint-disable-line

export function getAppArgs(): any {
	const parsed = minimist(process.argv);
	const appArgs = Array.isArray(parsed._) ? parsed._.filter((arg: unknown) => typeof arg === 'string') : [];
	return Object.assign(parsed, minimist(appArgs));
}
