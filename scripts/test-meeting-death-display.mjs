import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
	'VoiceController.ts',
	await readFile('src/renderer/voice/VoiceController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const controller = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'VoiceController');
const method = controller.members.find((node) => node.name?.getText(source) === 'refreshMeetingDeathDisplay');
const code = ts.transpileModule(`class Subject { ${method.getText(source)} }\nSubject`, {
	compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const Subject = vm.runInNewContext(code, { GameState: { TASKS: 2, DISCUSSION: 3 } });
const subject = new Subject();
let publications = 0;
subject.snapshot = { otherDead: { 22: false } };
subject.patch = ({ otherDead }) => {
	subject.snapshot.otherDead = otherDead;
	publications++;
};
const player = { clientId: 22, isDead: true, disconnected: false };
subject.refreshMeetingDeathDisplay({ gameState: 2, players: [player] });
assert.equal(subject.snapshot.otherDead[22], false, 'Task death stays hidden');
subject.refreshMeetingDeathDisplay({ gameState: 3, players: [player] });
assert.equal(subject.snapshot.otherDead[22], true, 'Meeting death becomes a ghost immediately');
subject.refreshMeetingDeathDisplay({ gameState: 3, players: [player] });
assert.equal(publications, 1, 'Unchanged meeting state does not republish');
player.isDead = false;
subject.refreshMeetingDeathDisplay({ gameState: 3, players: [player] });
assert.equal(subject.snapshot.otherDead[22], false, 'Revival restores the living appearance');
console.log('PASS meeting death display');
