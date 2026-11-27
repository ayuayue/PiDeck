import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { stripMarkdown } = loadTsCommonJs("src/renderer/src/utils/markdownPlainText.ts");

test("plain-text conversion preserves priority labels before file links", () => {
	const markdown = "1. **[P1] Title** [file.cpp:42](/tmp/file.cpp:42) · [other.cpp:9](/tmp/other.cpp:9)\n- **[P2] Other** [file.cpp:8](/tmp/file.cpp:8)";
	assert.equal(stripMarkdown(markdown), "[P1] Title file.cpp:42 · other.cpp:9\n[P2] Other file.cpp:8");
});

test("ordinary brackets remain intact before inline links", () => {
	assert.equal(stripMarkdown("[note] [label](url)"), "[note] label");
	assert.equal(stripMarkdown("[note][label](url)"), "[note]label");
	assert.equal(stripMarkdown("[note]\n\n[label](url)"), "[note]\n\nlabel");
});

test("renders inline, reference and image labels without their destinations", () => {
	assert.equal(stripMarkdown("[Read [docs [API]]](url_(v2))"), "Read [docs [API]]");
	assert.equal(stripMarkdown("[guide][docs](draft note)\n\n[docs]: /ref"), "guide(draft note)");
	assert.equal(stripMarkdown("![preview](image.png)"), "preview");
});

test("preserves block spacing, checkboxes and literal code", () => {
	const markdown = "## Heading\n\n- [x] Done\n  - Nested\n- [ ] Later\n\n> Note **text**\n\n```js\nconst value = '[label](value)';\n```";
	assert.equal(stripMarkdown(markdown), "Heading\n\n[x] Done\n  Nested\n[ ] Later\n\nNote text\n\nconst value = '[label](value)';");
});

test("keeps the table layout while converting labels inside cells", () => {
	const markdown = "| Item | Status |\n| --- | :---: |\n| [guide](docs) | [P1] |";
	assert.equal(stripMarkdown(markdown), "| Item | Status |\n| --- | :---: |\n| guide | [P1] |");
});
