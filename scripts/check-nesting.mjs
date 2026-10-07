import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

// Count nested control statements within each function, including try and else-if.
const limit = 3;
async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return /\.(tsx?|mjs|js)$/.test(entry.name) ? [path] : [];
		})
	);
	return files.flat();
}
function inspect(path, text) {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	let deepest = { depth: 0, line: 0 };
	function visit(node, depth) {
		if (ts.isFunctionLike(node)) depth = 0;
		if (
			ts.isIfStatement(node) ||
			ts.isIterationStatement(node, false) ||
			ts.isSwitchStatement(node) ||
			ts.isTryStatement(node)
		)
			depth++;
		if (depth > deepest.depth)
			deepest = { depth, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 };
		ts.forEachChild(node, (child) => visit(child, depth));
	}
	visit(source, 0);
	return { path, ...deepest };
}
const files = (await Promise.all(['src', 'scripts', 'server'].map(sourceFiles))).flat();
const results = await Promise.all(files.map(async (path) => inspect(path, await readFile(path, 'utf8'))));
const violations = results.filter((result) => result.depth > limit);
violations.forEach(({ path, line, depth }) => console.error(`${path}:${line}: nesting ${depth} exceeds ${limit}`));
if (violations.length) process.exitCode = 1;
else
	console.log(
		`PASS nesting: ${files.length} TS/JS files, maximum control depth ${Math.max(...results.map((result) => result.depth))}`
	);
