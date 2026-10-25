import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const pin = compile("src/renderer/src/hooks/timeline/browsePin.ts");

test("browse pin adds only the anchored row's viewport drift to scrollTop", () => {
	// 上方插入 600px 后，钉住的行从 80 被推到 680；scrollTop 应加 600，不是整页增高。
	assert.equal(pin.browsePinDrift(680, 80), 600);
	assert.equal(pin.browsePinScrollTop(40, 680, 80), 640);
	// 无漂移：不改 scrollTop
	assert.equal(pin.browsePinScrollTop(240, 80, 80), 240);
	// 行顶在视口上方（负偏移）同样按差补偿
	assert.equal(pin.browsePinScrollTop(100, -20, -80), 160);
});

test("browse pin does not compensate while following or when the row is gone", () => {
	assert.equal(
		pin.shouldCompensateBrowsePin({
			following: true,
			currentViewportTop: 680,
			expectedViewportTop: 80,
		}),
		false,
	);
	assert.equal(
		pin.shouldCompensateBrowsePin({
			following: false,
			currentViewportTop: null,
			expectedViewportTop: 80,
		}),
		false,
	);
	assert.equal(
		pin.shouldCompensateBrowsePin({
			following: false,
			currentViewportTop: 80.2,
			expectedViewportTop: 80,
		}),
		false,
	);
	assert.equal(
		pin.shouldCompensateBrowsePin({
			following: false,
			currentViewportTop: 680,
			expectedViewportTop: 80,
		}),
		true,
	);
});

test("user scroll updates the expected offset instead of gluing the old row", () => {
	const next = pin.followBrowsePinAfterUserScroll({ messageId: "run-4", expectedViewportTop: 80 }, -40);
	assert.equal(next.messageId, "run-4");
	assert.equal(next.expectedViewportTop, -40);
	const missing = pin.followBrowsePinAfterUserScroll({ messageId: "run-4", expectedViewportTop: 80 }, null);
	assert.equal(missing.expectedViewportTop, 80);
});

test("container height-delta is not the browse-pin contract", () => {
	const source = readFileSync("src/renderer/src/hooks/timeline/browsePin.ts", "utf8");
	assert.match(source, /browsePinScrollTop/);
	assert.match(source, /expectedViewportTop/);
	assert.doesNotMatch(source, /function browsePin[\s\S]*scrollHeight/);
});
