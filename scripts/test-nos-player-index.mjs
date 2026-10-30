import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const file = 'src/main/GameReader.ts';
const currentSource = await readFile(process.env.TANUKI_NOS_PLAYER_INDEX_BASELINE ?? file, 'utf8');
const marker = path.resolve('.git');
const gitDirectory = (await stat(marker)).isDirectory()
	? marker
	: path.resolve((await readFile(marker, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
const previousSource = execFileSync('git', [`--git-dir=${gitDirectory}`, 'show', `HEAD:${file}`], {
	encoding: 'utf8',
});

// Execute the actual appearance/missing-data statements and read-status expression.
// Native memory reads and unrelated role processing remain outside this focused fixture.
function extract(source) {
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const reader = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'GameReader');
	const loop = reader.members.find((node) => node.name?.getText(parsed) === 'loop');
	const statements = loop.body.statements.find(ts.isTryStatement).tryBlock.statements;
	const declaration = (statement, name) =>
		ts.isVariableStatement(statement) &&
		statement.declarationList.declarations.some((node) => node.name.getText(parsed) === name);
	const appearance = statements.find(
		(statement) =>
			ts.isIfStatement(statement) && statement.thenStatement.getText(parsed).includes('this.applyNosAppearance(')
	);
	const missing = statements.find((statement) => declaration(statement, 'missingNosPlayers'));
	const state = statements.find((statement) => declaration(statement, 'newState'));
	const status = state.declarationList.declarations[0].initializer.arguments[0].properties.find(
		(property) => property.name.getText(parsed) === 'nosReadStatus'
	).initializer;
	assert.ok(appearance && missing && status, 'Use production appearance calls, missing check and status');
	const selected = statements.filter(
		(statement) => declaration(statement, 'nosPlayers') || statement === appearance || statement === missing
	);
	return ts.transpileModule(
		`(function (nos, players, state, snrActive, nosLobbyColors) {
			${selected.map((statement) => statement.getText(parsed)).join('\n')}
			return { missingNosPlayers, status: ${status.getText(parsed)} };
		})`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }
	).outputText;
}

function runtime(source) {
	const count = { ids: 0, maps: 0, has: 0 };
	class CountedMap extends Map {
		constructor(entries) {
			super(entries);
			count.maps++;
		}
		has(key) {
			count.has++;
			return super.has(key);
		}
	}
	const execute = vm.runInNewContext(extract(source), { Map: CountedMap, path, GameState: { MENU: 'MENU' } });
	return {
		run({ ids, disconnected = [], mod = 'NoS', state = 'TASKS', active = true, cosmetics = true }) {
			Object.assign(count, { ids: 0, maps: 0, has: 0 });
			const appearances = [];
			const players = Array.from({ length: 15 }, (_, id) => ({ id, disconnected: disconnected.includes(id) }));
			const nos =
				ids === undefined
					? undefined
					: {
							players: ids.map((id, index) => ({
								get playerId() {
									count.ids++;
									return id;
								},
								appearance: `costume-${index}`,
							})),
						};
			const reader = {
				loadedMod: { id: mod },
				gamePath: '/game/Among Us.exe',
				cosmeticsEnabled: cosmetics,
				nosContents: { update() {} },
				nosSnapshot: { message: 'Snapshot unavailable', schemaVersion: 20261009 },
				applyNosAppearance(player, data, color, phase) {
					appearances.push([player.id, data?.appearance, color, phase]);
				},
			};
			const result = execute.call(reader, nos, players, state, active, { 0: '#abcdef' });
			return {
				missing: Array.from(result.missingNosPlayers, (player) => player.id),
				status: result.status && { ...result.status },
				appearances,
				count: { ...count },
			};
		},
	};
}

const current = runtime(currentSource);
const previous = runtime(previousSource);
function compare(options) {
	const observed = current.run(options);
	const reference = previous.run(options);
	const output = ({ count: _count, ...value }) => value;
	assert.deepEqual(output(observed), output(reference), 'Appearance and exact missing-data status must stay unchanged');
	return { observed, reference };
}

const ids = Array.from({ length: 15 }, (_, id) => id);
const full = compare({ ids });
assert.equal(full.observed.count.ids, 15, 'Each published player ID is indexed just once');
assert.equal(full.observed.count.maps, 1, 'Appearance and validation share one current-frame table');
assert.equal(full.observed.count.has, 15, 'One membership lookup per connected player');
assert.equal(full.observed.status.failed, false);
assert.deepEqual(full.observed.missing, []);

const partial = compare({ ids: [0, 3, 7], disconnected: [2, 9] });
assert.deepEqual(partial.observed.missing, [1, 4, 5, 6, 8, 10, 11, 12, 13, 14]);
assert.equal(partial.observed.status.failed, true);
assert.equal(partial.observed.status.message, 'NoSプレイヤーデータ未取得: PlayerId 1, 4, 5, 6, 8, 10, 11, 12, 13, 14');
assert.equal(partial.observed.count.ids, 3);
assert.equal(partial.observed.count.has, 13, 'Disconnected players are not checked');

const duplicates = compare({ ids: [0, 0, 3, 3, 7] });
assert.equal(duplicates.observed.appearances[0][1], 'costume-1', 'Last duplicate appearance still wins');
assert.equal(duplicates.observed.appearances[3][1], 'costume-3');
compare({ ids: [] });
compare({ ids: [0, 3, 7], state: 'LOBBY', active: false });
compare({ ids: [], state: 'MENU', active: false });
compare({ ids, disconnected: ids });
compare({ ids, cosmetics: false });
for (const mod of ['NoS', 'NONE', 'TOH4E']) {
	const missing = compare({ mod });
	assert.equal(missing.observed.count.maps, 0, 'No table is needed without a snapshot');
	assert.deepEqual(missing.observed.missing, []);
	if (mod === 'NoS') assert.equal(missing.observed.status.failed, true);
}
const replacement = compare({ ids: [14] });
assert.deepEqual(replacement.observed.missing, ids.slice(0, 14), 'A later frame must not reuse older membership');
assert.equal(replacement.observed.appearances[0][1], undefined);
assert.equal(replacement.observed.appearances[14][1], 'costume-0');

console.log(
	`PASS current-frame NoS player index: 15-player ID reads ${full.reference.count.ids} -> ${full.observed.count.ids}; exact appearance/status parity for missing, partial, duplicate, disconnected, Lite, lobby and replacement snapshots`
);
