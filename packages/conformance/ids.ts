// A row's key: the test's file, then its describe titles and its own title, as vitest reports them.
export const testId = (file: string, titles: readonly string[]): string => `${file} :: ${titles.join(" > ")}`;

// Returns the path of a vitest test file relative to the package.
export function relativeFile(absolute: string, root: string): string {
	if (!absolute.startsWith(`${root}/`)) throw new Error(`conformance: ${absolute} is outside ${root}`);
	return absolute.slice(root.length + 1);
}
