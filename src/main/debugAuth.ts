import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

export function verifyDebugPassword(password: unknown, configuration = process.env.TANUKI_DEBUG_AUTH): boolean {
	if (typeof password !== 'string' || !password || password.length > 1024 || !configuration) return false;
	try {
		const { salt, hash } = JSON.parse(configuration);
		if (!/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{64}$/i.test(hash)) return false;
		return timingSafeEqual(
			pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256'),
			Buffer.from(hash, 'hex')
		);
	} catch {
		return false;
	}
}
