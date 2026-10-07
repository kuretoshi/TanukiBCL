/** Enumerate all combinations without deeply nested test loops. */
export function combinations(choices) {
	return Object.entries(choices).reduce(
		(cases, [key, values]) => cases.flatMap((testCase) => values.map((value) => ({ ...testCase, [key]: value }))),
		[{}]
	);
}
