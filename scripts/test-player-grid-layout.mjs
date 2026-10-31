import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { runInNewContext } from 'node:vm';

const filename = new URL('../src/renderer/views/playerGridLayout.ts', import.meta.url);
const module = { exports: {} };
runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
	module,
	exports: module.exports,
	require: createRequire(import.meta.url),
});
const { getPlayerGridLayout, playerAvatarChrome, playerGridGap, playerGroupHeaderHeight } = module.exports;

// The reported two-person lobby has one remote player under a life-group heading.
assert.equal(getPlayerGridLayout(268, 230, 1, 1).avatarSize, 80);
assert.equal(getPlayerGridLayout(268, 230, 1, 0).avatarSize, 80);
assert.equal(getPlayerGridLayout(268, 230, 1).avatarSize, 100, 'Standard layout retains its existing size');

let checked = 0;
const viewports = [248, 268, 328, 568].flatMap((width) => [180, 250, 400, 600].map((height) => [width, height]));
for (const [width, height] of viewports) {
	for (let count = 1; count <= 24; count++) {
		for (const alive of [undefined, ...Array.from({ length: count + 1 }, (_, index) => index)]) {
			const { columns, avatarSize } = getPlayerGridLayout(width, height, count, alive);
			const aliveCount = alive ?? count;
			const ghostCount = count - aliveCount;
			const headers = alive === undefined ? 0 : Number(aliveCount > 0) + Number(ghostCount > 0);
			const rows = Math.ceil(aliveCount / columns) + Math.ceil(ghostCount / columns);
			const usedWidth = columns * (avatarSize + playerAvatarChrome) + (columns - 1) * playerGridGap;
			const usedHeight =
				rows * (avatarSize + playerAvatarChrome) +
				headers * playerGroupHeaderHeight +
				(rows + headers - 1) * playerGridGap;
			const description = JSON.stringify({ width, height, count, alive });
			assert.ok(columns >= 1 && columns <= count, description);
			assert.ok(avatarSize >= 1 && avatarSize <= (alive === undefined ? 100 : 80), description);
			assert.ok(usedWidth <= width && usedHeight <= height, `All avatars and headings fit: ${description}`);
			checked++;
		}
	}
}
assert.equal(getPlayerGridLayout(268, 230, 0, 0).columns, 1);
console.log(`ok player grid: reported sparse layout, standard size and ${checked} roster/viewport combinations`);
