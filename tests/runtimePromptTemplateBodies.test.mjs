import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 主进程读运行时模板正文（W2）。
 * 输入只认 pi `get_commands` 报出的 sourceInfo.path，不认任意路径。
 */

const mod = loadTsCommonJs("src/main/prompts/runtimeTemplateBodies.ts");

/** 跨平台绝对路径：Windows 上 `/a/x.md` 不是绝对路径，测试必须用 resolve() 生成。 */
const abs = (name) => resolve("test-fixtures", name);
/** vm 沙箱里造的对象与宿主 realm 原型不同，deepEqual 会因原型判定失败，这里拉平。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeFs(files) {
	const stats = new Map(Object.entries(files).map(([path, spec]) => [path, spec]));
	return {
		statFile: async (path) => {
			const spec = stats.get(path);
			if (!spec) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return { size: spec.size ?? spec.content.length, isFile: () => spec.isFile !== false };
		},
		readTextFile: async (path) => stats.get(path).content,
	};
}

test("只读 source=prompt 的条目，扩展/技能命令不读文件", async () => {
	const deps = fakeFs({ [abs("a/commit.md")]: { content: "COMMIT" } });
	const out = await mod.readRuntimePromptTemplateBodies(
		[
			{ name: "commit", source: "prompt", sourceInfo: { path: abs("a/commit.md") } },
			{ name: "plan", source: "extension", sourceInfo: { path: abs("a/plan.ts") } },
			{ name: "skill:demo", source: "skill", sourceInfo: { path: abs("a/demo/SKILL.md") } },
		],
		deps,
	);
	assert.deepEqual(plain(out), [{ name: "commit", content: "COMMIT" }]);
});

test("非绝对路径 / 非 .md / 目录 / 超限 一律跳过", async () => {
	const deps = fakeFs({
		[abs("ok.md")]: { content: "OK" },
		[abs("big.md")]: { content: "x", size: 256 * 1024 + 1 },
		[abs("dir.md")]: { content: "", isFile: false },
	});
	const out = await mod.readRuntimePromptTemplateBodies(
		[
			{ name: "rel", source: "prompt", sourceInfo: { path: "relative/x.md" } },
			{ name: "txt", source: "prompt", sourceInfo: { path: abs("x.txt") } },
			{ name: "big", source: "prompt", sourceInfo: { path: abs("big.md") } },
			{ name: "dir", source: "prompt", sourceInfo: { path: abs("dir.md") } },
			{ name: "ok", source: "prompt", sourceInfo: { path: abs("ok.md") } },
		],
		deps,
	);
	assert.deepEqual(plain(out), [{ name: "ok", content: "OK" }]);
});

test("读失败降级为空（不抛，不阻断发送）", async () => {
	const deps = {
		statFile: async () => {
			throw new Error("EACCES");
		},
		readTextFile: async () => "",
	};
	const out = await mod.readRuntimePromptTemplateBodies([{ name: "x", source: "prompt", sourceInfo: { path: abs("x.md") } }], deps);
	assert.deepEqual(plain(out), []);
});

test("重名保留第一个（get_commands 已按 pi 优先级去重）", async () => {
	const deps = fakeFs({ [abs("a.md")]: { content: "A" }, [abs("b.md")]: { content: "B" } });
	const out = await mod.readRuntimePromptTemplateBodies(
		[
			{ name: "dup", source: "prompt", sourceInfo: { path: abs("a.md") } },
			{ name: "dup", source: "prompt", sourceInfo: { path: abs("b.md") } },
		],
		deps,
	);
	assert.deepEqual(plain(out), [{ name: "dup", content: "A" }]);
});

test("畸形输入不崩：null / 非数组 / 缺字段", async () => {
	assert.deepEqual(plain(await mod.readRuntimePromptTemplateBodies(null)), []);
	assert.deepEqual(plain(await mod.readRuntimePromptTemplateBodies("nope")), []);
	assert.deepEqual(plain(await mod.readRuntimePromptTemplateBodies([null, 1, { name: "" }, { source: "prompt" }])), []);
});
