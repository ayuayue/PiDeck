import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 本地展开的让路集合（DSH / pi 通用）。
 *
 * 规则：`source === "prompt"` 的是提示词模板（要展开）；其余由后端执行（必须让路）。
 * 背景见 utils/reservedCommandNames 注释：展开后消息不再以 `/` 开头，
 * DSH 的 slash 桥与 pi 的扩展命令都会静默失效。
 */

const { collectReservedCommandNames, needsTemplateRefetch } = loadTsCommonJs("src/renderer/src/utils/reservedCommandNames.ts");
const plain = (set) => Array.from(set).sort();

test("prompt 来源不保留（那是要被展开的模板）", () => {
	assert.deepEqual(plain(collectReservedCommandNames([{ name: "commit", source: "prompt" }])), []);
});

test("扩展命令 / 技能 / DSH host 命令都保留", () => {
	assert.deepEqual(
		plain(
			collectReservedCommandNames([
				{ name: "plan", source: "extension" },
				{ name: "skill:cv-writer", source: "skill" },
				{ name: "permission", source: "dsh" },
				{ name: "commit", source: "prompt" },
			]),
		),
		["permission", "plan", "skill:cv-writer"],
	);
});

test("source 缺省视为后端接管（宁可让路，不抢命令）", () => {
	assert.deepEqual(plain(collectReservedCommandNames([{ name: "mystery" }])), ["mystery"]);
});

test("桌面内置命令不占位：用户仍可建同名提示词模板", () => {
	// builtin 由 classifyComposerSlashCommand 接管，未接管的本来就只是文本；
	// 若把 builtin 当保留项，`/export` 这类模板会被静默地发成字面量。
	assert.deepEqual(
		plain(
			collectReservedCommandNames([
				{ name: "export", source: "builtin" },
				{ name: "copy", source: "builtin" },
			]),
		),
		[],
	);
});

test("ACP 命令（source=acp）同样让路", () => {
	assert.deepEqual(plain(collectReservedCommandNames([{ name: "compact", source: "acp" }])), ["compact"]);
});

test("pi 技能只保留 /skill:名称 形态，不误封同名模板", () => {
	const reserved = collectReservedCommandNames([{ name: "skill:commit", source: "skill" }]);
	assert.ok(reserved.has("skill:commit"));
	assert.ok(!reserved.has("commit"), "裸 /commit 在 pi 上仍是模板调用");
});

test("空名/畸形条目忽略，不产生垃圾保留项", () => {
	assert.deepEqual(plain(collectReservedCommandNames([{ name: "" }, { name: "ok", source: "dsh" }])), ["ok"]);
});

test("需要补拉模板表的三种判定", () => {
	const templates = [{ name: "commit" }];
	const reserved = new Set(["permission"]);
	// 已知模板：不用补拉
	assert.equal(needsTemplateRefetch("commit", templates, reserved), false);
	// 后端命令：补拉也没用（否则每次 /permission 都白跑三趟 IPC）
	assert.equal(needsTemplateRefetch("permission", templates, reserved), false);
	// 未知模板：需要补拉（可能是包带模板）
	assert.equal(needsTemplateRefetch("parallel-review", templates, reserved), true);
	// 非命令形态
	assert.equal(needsTemplateRefetch(undefined, templates, reserved), false);
	assert.equal(needsTemplateRefetch("", templates, reserved), false);
});
