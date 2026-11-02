/**
 * /api/state 会话投影的父关系解析（WebSessionProjection）。
 *
 * 修正动机：目录记录只存父会话文件路径（parentSessionPath），而 Web 端不下发文件路径，
 * 侧栏因此拿不到父子关系、把子代理会话平铺成顶层行。投影层把路径解析成 parentSessionId，
 * 渲染层才能折叠。这里钉死解析口径：Windows 路径不区分大小写、WSL 保留大小写、
 * 父会话不在同批记录时不下发（子会话按顶层展示，入口不能消失）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toPublicSessions } = loadTsCommonJs("src/main/web/WebSessionProjection.ts");

function record(id, overrides = {}) {
	return {
		id,
		projectId: "p1",
		title: id,
		source: "pi",
		environment: "native",
		status: "active",
		preview: "",
		messageCount: 0,
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

test("子会话的 parentSessionPath 解析成父会话 id", () => {
	const parent = record("parent", { filePath: "C:/sessions/parent.jsonl" });
	const child = record("child", { filePath: "C:/sessions/child.jsonl", parentSessionPath: "C:/sessions/parent.jsonl" });
	const projected = toPublicSessions([parent, child]);

	assert.equal(projected[0].parentSessionId, undefined, "父会话本身不带父关系");
	assert.equal(projected[1].parentSessionId, "parent");
	// 文件路径本身仍然不下发（载荷治理：/api/state 只发 Web 真正消费的字段）
	assert.equal("filePath" in projected[1], false);
	assert.equal("parentSessionPath" in projected[1], false);
});

test("Windows 路径按大小写不敏感匹配（同一文件的不同写法）", () => {
	const parent = record("parent", { filePath: "C:\\Users\\Me\\.pi\\sessions\\parent.jsonl" });
	const child = record("child", { parentSessionPath: "c:/users/me/.pi/sessions/PARENT.jsonl" });
	const projected = toPublicSessions([parent, child]);
	assert.equal(projected[1].parentSessionId, "parent");
});

test("WSL 路径保留大小写，不做小写归一", () => {
	const parent = record("parent", { environment: "wsl", filePath: "/home/me/.pi/sessions/Parent.jsonl" });
	const child = record("child", { environment: "wsl", parentSessionPath: "/home/me/.pi/sessions/parent.jsonl" });
	const projected = toPublicSessions([parent, child]);
	assert.equal(projected[1].parentSessionId, undefined, "大小写不同就是不同文件");
});

test("父会话不在同批记录里时不下发 parentSessionId（渲染层降级为顶层行）", () => {
	const child = record("child", { parentSessionPath: "C:/sessions/gone.jsonl" });
	const projected = toPublicSessions([child]);
	assert.equal(projected[0].parentSessionId, undefined);
});
