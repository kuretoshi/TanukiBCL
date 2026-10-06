import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

export const MAX_DEBUG_PASSWORDS = 16;

export function verifyDebugPassword(password: unknown, configuration = process.env.TANUKI_DEBUG_AUTH): boolean {
	if (typeof password !== 'string' || !password || password.length > 1024 || !configuration) return false;
	try {
		const parsed = JSON.parse(configuration);
		const records = parsed && Object.prototype.hasOwnProperty.call(parsed, 'passwords') ? parsed.passwords : [parsed];
		if (!Array.isArray(records) || !records.length || records.length > MAX_DEBUG_PASSWORDS) return false;
		if (
			!records.every(
				(record) =>
					record &&
					typeof record.salt === 'string' &&
					typeof record.hash === 'string' &&
					/^[a-f0-9]{32}$/i.test(record.salt) &&
					/^[a-f0-9]{64}$/i.test(record.hash)
			)
		)
			return false;
		return records.some(({ salt, hash }) =>
			timingSafeEqual(pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256'), Buffer.from(hash, 'hex'))
		);
	} catch {
		return false;
	}
}
