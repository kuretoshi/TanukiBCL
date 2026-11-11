// Vosk's final word tokens preserve word boundaries. Never turn the whole
// transcript (or a partial hypothesis) into an obstacle.
const functionWords = new Set([
	'えー',
	'ええ',
	'えっと',
	'あの',
	'その',
	'この',
	'それ',
	'これ',
	'はい',
	'うん',
	'は',
	'が',
	'の',
	'を',
	'に',
	'へ',
	'と',
	'で',
	'も',
	'ね',
	'よ',
	'です',
	'ます',
	'だ',
]);
export function validStoneWord(value: unknown, maximum: number): value is string {
	return (
		typeof value === 'string' &&
		Number.isInteger(maximum) &&
		maximum >= 1 &&
		maximum <= 12 &&
		value.length <= 64 &&
		value === value.normalize('NFKC') &&
		Array.from(value).length >= 1 &&
		Array.from(value).length <= maximum &&
		/^[\p{L}\p{Nd}ー々]+$/u.test(value)
	);
}
export function recognisedStoneWord(tokens: unknown, final: boolean, maximum: number): string | undefined {
	if (!final || !Array.isArray(tokens) || tokens.length > 64) return;
	for (const token of tokens) {
		if (!token || typeof token.word !== 'string' || token.word.length > 64) continue;
		if (
			token.conf !== undefined &&
			(typeof token.conf !== 'number' || !Number.isFinite(token.conf) || token.conf < 0.55)
		)
			continue;
		const word = token.word.normalize('NFKC');
		if (validStoneWord(word, maximum) && !functionWords.has(word)) return word;
	}
}
