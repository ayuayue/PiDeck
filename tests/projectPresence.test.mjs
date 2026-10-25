import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { attachProjectPresence } = loadTsCommonJs("src/main/projects/projectPresence.ts");

/**
 * 项目目录存在性检测（方案 B：标记显示，不自动删除）。
 *
 * 背景：目录被删除后项目列表仍残留（2026-08 反馈）。修复为 stat 检测 +
 * missing 标记，列表保留记录由用户决定移除或恢复；规则保守：
 * - chat 项目跳过（userData 下自动创建）
 * - WSL 项目 stat 失败时先查发行版根（UNC \\wsl.localhost\<distro>）：
 *   根不可达 = 发行版未启动，不标记（避免误报）；根可达但路径缺失 = 真缺失
 */

function project(overrides = {}) {
	return {
		id: "p1",
		name: "proj",
		path: "C:\\repo\\proj",
		lastOpenedAt: 1,
		environment: "windows",
		...overrides,
	};
}

/** 模拟路径检查：给定「存在的路径」集合，其余视为不存在。 */
function makeCheck(existingPaths) {
	const existing = new Set(existingPaths);
	return async (path) => existing.has(path);
}

test("windows 项目目录存在 → 不标记", async () => {
	const result = await attachProjectPresence([project({ path: "C:\\repo\\proj" })], makeCheck(["C:\\repo\\proj"]));
	assert.equal(result[0].missing, undefined);
	assert.equal(result[0].id, "p1");
});

test("windows 项目目录不存在 → 标记 missing", async () => {
	const result = await attachProjectPresence([project({ path: "C:\\repo\\gone" })], makeCheck([]));
	assert.equal(result[0].missing, true);
});

test("chat 项目跳过检测（userData 下自动创建）", async () => {
	const result = await attachProjectPresence([project({ id: "builtin-chat", name: "Chat", kind: "chat", path: "" })], makeCheck([]));
	assert.equal(result[0].missing, undefined);
});

test("WSL 发行版未启动（UNC 根不可达）→ 不标记，避免误报", async () => {
	const result = await attachProjectPresence(
		[
			project({
				path: "\\\\wsl.localhost\\ubuntu\\home\\me\\proj",
				environment: "wsl",
			}),
		],
		// 项目路径和发行版根都不可达 → 视为环境未就绪，不标记
		makeCheck([]),
	);
	assert.equal(result[0].missing, undefined);
});

test("WSL 发行版可达但项目路径缺失 → 标记 missing", async () => {
	const result = await attachProjectPresence(
		[
			project({
				path: "\\\\wsl.localhost\\ubuntu\\home\\me\\gone",
				environment: "wsl",
			}),
		],
		// 发行版根可达（WSL 已启动），项目目录已删除
		makeCheck(["\\\\wsl.localhost\\ubuntu"]),
	);
	assert.equal(result[0].missing, true);
});

test("WSL 项目路径存在 → 不标记", async () => {
	const result = await attachProjectPresence(
		[
			project({
				path: "\\\\wsl.localhost\\ubuntu\\home\\me\\proj",
				environment: "wsl",
			}),
		],
		makeCheck(["\\\\wsl.localhost\\ubuntu\\home\\me\\proj"]),
	);
	assert.equal(result[0].missing, undefined);
});

test("wsl$ 旧式 UNC 前缀同样识别发行版", async () => {
	const result = await attachProjectPresence(
		[
			project({
				path: "\\\\wsl$\\ubuntu\\home\\me\\gone",
				environment: "wsl",
			}),
		],
		makeCheck(["\\\\wsl.localhost\\ubuntu"]),
	);
	assert.equal(result[0].missing, true);
});

test("无路径项目跳过检测", async () => {
	const result = await attachProjectPresence([project({ path: "" })], makeCheck([]));
	assert.equal(result[0].missing, undefined);
});
