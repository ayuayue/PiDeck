import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import {
	filePathFromHref,
	normalizeLocalFilePath,
	stripFileLocation,
	toInternalFileHref,
} from "../src/renderer/src/utils/fileLinks";

const localTargets = [
	"C:/Users/Administrator/.pi/agent/settings.json",
	"C:\\Users\\Administrator\\.pi\\agent\\settings.json",
	"/C:/Users/Administrator/project/src/App.tsx:392",
	"/home/user/project/src/app.py:12:4",
	"./src/app.ts",
	"../docs/README.md",
	"src/components/App.tsx:42",
	"settings.json",
	"settings.json:8",
];

for (const target of localTargets) {
	const normalized = normalizeLocalFilePath(target);
	assert.ok(normalized, `expected local file target: ${target}`);
	const href = toInternalFileHref(target);
	assert.ok(href?.startsWith("file://"), `expected internal href: ${target}`);
	assert.equal(filePathFromHref(href), normalized);
}

const externalTargets = [
	"https://example.com/docs/readme.md",
	"http://example.com/file.json",
	"mailto:user@example.com",
	"#section",
	"/docs/getting-started",
	"//example.com/docs/file.md",
];

for (const target of externalTargets) {
	assert.equal(normalizeLocalFilePath(target), null, `expected external target: ${target}`);
	assert.equal(toInternalFileHref(target), null);
}

assert.equal(normalizeLocalFilePath("/C:/Users/Test/file.ts:9"), "C:/Users/Test/file.ts:9");
assert.equal(stripFileLocation("C:/Users/Test/file.ts:9:3"), "C:/Users/Test/file.ts");
assert.equal(stripFileLocation("C:/Users/Test/file.ts"), "C:/Users/Test/file.ts");
assert.equal(
	filePathFromHref("file://C%3A%2FUsers%2FTest%2FMy%20File.ts%3A9"),
	"C:/Users/Test/My File.ts:9",
);

const markdownTargets = [
	"[settings.json](C:/Users/Administrator/.pi/agent/settings.json)",
	"[App.tsx](/C:/Users/Administrator/project/src/App.tsx:392)",
	"[app.py](/home/user/project/app.py:12:4)",
	"[README](../docs/README.md)",
];
const markdownParser = unified().use(remarkParse);
for (const markdown of markdownTargets) {
	const tree = markdownParser.parse(markdown) as any;
	const link = tree.children[0]?.children[0];
	assert.equal(link?.type, "link", `expected Markdown link node: ${markdown}`);
	assert.ok(toInternalFileHref(link.url), `expected Markdown file target: ${link?.url}`);
}

console.log(`file link tests passed (${localTargets.length + externalTargets.length + 8} assertions)`);
