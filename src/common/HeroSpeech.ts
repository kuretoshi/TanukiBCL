export interface HeroSpeechPlayer {
	playerId: number;
	kind: 'hero' | 'ng';
	request: number;
	expires: number;
	words: string[];
}
export type SpeechPlatform = 'desktop' | 'web' | 'mobile';
export function shouldRecogniseSpeech(local: boolean, host: boolean, platform?: SpeechPlatform): boolean {
	return local || (host && (platform === 'web' || platform === 'mobile'));
}
export function normaliseSpeech(text: string): string {
	return text
		.normalize('NFKC')
		.toLocaleLowerCase('ja')
		.replace(/[\s、。！!？?・]/g, '')
		.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
export function heardForbiddenWord(text: unknown, words: readonly string[], final: boolean): boolean {
	if (!final || typeof text !== 'string' || text.length > 4096) return false;
	const normal = normaliseSpeech(text);
	return words.some((word) => normaliseSpeech(word).length >= 2 && normal.includes(normaliseSpeech(word)));
}
export interface HeroSpeechState {
	pid: number;
	session: string;
	players: HeroSpeechPlayer[];
}
export function heardHenshin(text: unknown, final = true): boolean {
	if (typeof text !== 'string' || text.length > 4096) return false;
	const normalized = text.normalize('NFKC').replace(/[\s、。！!？?・]/g, '');
	return (
		normalized.includes('変身') ||
		normalized.includes('へんしん') ||
		normalized.includes('ヘンシン') ||
		(final && normalized === '返信')
	);
}
