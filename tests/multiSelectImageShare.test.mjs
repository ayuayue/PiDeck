import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

// AppUtils 已是纯转发 barrel（实现按域拆到 appUtils/*），用能递归解析生产依赖图的加载器；
// chips 仍显式桩掉（只用到 formatFilePathRef 的直通语义）。
function loadAppUtils() {
	return loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts", {
		stubs: { "../../session/composer/chips": { formatFilePathRef: (p) => p } },
	});
}

test("multi-select image export stays renderable for html-to-image", () => {
	const styles = readRendererStyles();
	const rule = styles.match(/\.multi-select-image-export \{([\s\S]*?)\n\}/)?.[1] ?? "";

	assert.match(rule, /left:\s*0;/);
	assert.doesNotMatch(rule, /-100000px/);
});

test("multi-select image export maps selected assistant messages to their visible run rows", () => {
	const { getMultiSelectImageCaptureIds } = loadAppUtils();
	const user = { kind: "message", message: { id: "u1", role: "user", text: "hi", timestamp: 1 } };
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 2,
		endedAt: 3,
		items: [
			{ kind: "message", message: { id: "a1", role: "assistant", text: "first", timestamp: 2 } },
			{ kind: "message", message: { id: "a2", role: "assistant", text: "second", timestamp: 3 } },
		],
	};

	const ids = getMultiSelectImageCaptureIds([user, run], new Set(["u1", "a2"]));

	assert.deepEqual([...ids], ["u1", "run-1"]);
});
