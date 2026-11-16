import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #539：归档/删除父会话时，平铺子代理（与父会话同目录、靠会话头 parentSession 指回父文件）
// 不在 `<stem>/` 里，会话文件必须跟着一起走，否则 catalog 摘了整棵子树、文件仍留在活动扫描目录，
// 下次扫描就变成失去父节点的孤儿行。
const { scatteredSubtreeFiles, runForScatteredSubtreeFiles } = loadTsCommonJs("src/main/sessions/sessionSubtreeFiles.ts");

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function sessionEntries(id, cwd, extra = {}) {
	return [
		{ type: "session", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd, ...extra },
		{ type: "message", id: `${id}-m1`, parentId: id, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: `hello ${id}` } },
	];
}

/** 只实现本函数用到的两个读端口；条目顺序模拟 catalog 的子树结果。 */
function fakeCatalog({ parentId, parentPath, children }) {
	const files = new Map([[parentId, parentPath], ...children.map((child) => [child.id, child.filePath])]);
	return {
		listSubtreeEntries: (id) => (id === parentId ? [{ id }, ...children.map((child) => ({ id: child.id }))] : [{ id }]),
		getLocalFilePath: (id) => files.get(id),
	};
}

test("scatteredSubtreeFiles picks flat subagent files and leaves nested dirs to their owner", () => {
	const root = "/home/u/.pi/agent/sessions/-proj";
	const parentPath = `${root}/parent.jsonl`;
	const catalog = fakeCatalog({
		parentId: "parent",
		parentPath,
		children: [
			{ id: "flat", filePath: `${root}/child-flat.jsonl` },
			// 孙会话在平铺子会话自己的 `<child-flat>/` 里：跟着它一起被 scanner 的 sibling 处理
			{ id: "grand", filePath: `${root}/child-flat/grand.jsonl` },
			// 嵌套布局：`<parent>/` 会随父文件一起搬走，不能单独再处理一次
			{ id: "nested", filePath: `${root}/parent/child-nested.jsonl` },
			// 没有本机路径的条目（草稿 / DSH 记录）不参与
			{ id: "draft", filePath: undefined },
		],
	});

	// 返回值来自沙箱里的另一个 vm realm：比较字段而不是原型（deepEqual 会因 Array 原型不同而报错）
	const scattered = scatteredSubtreeFiles({ catalog, sessionId: "parent", parentFilePath: parentPath, environment: "native" });
	assert.equal(scattered.length, 1, "只有平铺子代理需要单独处理");
	assert.equal(scattered[0].sessionId, "flat");
	assert.equal(scattered[0].filePath, `${root}/child-flat.jsonl`);
});

test("scatteredSubtreeFiles dedupes case-folded duplicates and ignores the parent itself", () => {
	const root = "C:\\Users\\u\\.pi\\agent\\sessions\\-proj";
	const parentPath = `${root}\\parent.jsonl`;
	const catalog = fakeCatalog({
		parentId: "parent",
		parentPath,
		children: [
			{ id: "flat", filePath: `${root}\\child-flat.jsonl` },
			// 同源归并后两条记录指向同一个文件：只能处理一次
			{ id: "flat-alias", filePath: `${root.toUpperCase()}\\CHILD-FLAT.JSONL` },
		],
	});

	const result = scatteredSubtreeFiles({ catalog, sessionId: "parent", parentFilePath: parentPath, environment: "native" });
	assert.equal(result.length, 1, "大小写折叠后同一个文件只应出现一次");
	assert.match(result[0].filePath, /child-flat\.jsonl$/i);
});

test("a child row without a local path (ssh locator / draft) is skipped, not fatal", () => {
	const root = "/home/u/.pi/agent/sessions/-proj";
	const parentPath = `${root}/parent.jsonl`;
	const catalog = {
		listSubtreeEntries: () => [{ id: "parent" }, { id: "remote" }, { id: "flat" }],
		getLocalFilePath: (id) => {
			// 生产实现里 getLocalFilePath 对 ssh locator 直接抛稳定码
			if (id === "remote") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			return id === "parent" ? parentPath : `${root}/child-flat.jsonl`;
		},
	};
	const result = scatteredSubtreeFiles({ catalog, sessionId: "parent", parentFilePath: parentPath, environment: "native" });
	assert.equal(result.length, 1, "抛错的那条要跳过，其余照常返回");
	assert.equal(result[0].sessionId, "flat");
});

test("archiving a parent moves the flat subagent file into .pideck-archive too", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-subtree-archive-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const projectDir = join(sessionsRoot, "-proj");
		const parentPath = join(projectDir, "parent.jsonl");
		const flatPath = join(projectDir, "child-flat.jsonl");
		const nestedPath = join(projectDir, "parent", "child-nested.jsonl");
		writeSession(parentPath, sessionEntries("parent0001", "C:\\proj"));
		writeSession(flatPath, sessionEntries("flat000001", "C:\\proj", { parentSession: parentPath, name: "explore#a1b2c3d4" }));
		writeSession(nestedPath, sessionEntries("nested0001", "C:\\proj", { parentSession: parentPath }));

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();
		const catalog = fakeCatalog({
			parentId: "parent",
			parentPath,
			children: [
				{ id: "flat", filePath: flatPath },
				{ id: "nested", filePath: nestedPath },
			],
		});

		await scanner.archive(parentPath);
		const failures = await runForScatteredSubtreeFiles({ catalog, sessionId: "parent", parentFilePath: parentPath, environment: "native", run: (filePath) => scanner.archive(filePath) });

		assert.equal(failures.length, 0, `平铺子代理归档不应失败：${failures.join(",")}`);
		assert.equal(existsSync(parentPath), false, "父会话文件应已移出活动目录");
		assert.equal(existsSync(flatPath), false, "平铺子代理文件不应留在活动扫描目录");
		assert.equal(existsSync(nestedPath), false, "嵌套子会话应随 <stem>/ 目录一起移走");

		const archivedNames = readdirSync(join(sessionsRoot, ".pideck-archive")).sort();
		// 嵌套目录 `<stem>/` 会随父文件一起搬进归档目录
		assert.deepEqual(archivedNames, ["child-flat.jsonl", "index.json", "parent", "parent.jsonl"], "归档目录里应同时有父会话与平铺子代理");

		// 两个文件各自有索引条目：归档列表可分别恢复（恢复父会话不会把多余目录搬回去）
		const index = JSON.parse(readFileSync(join(sessionsRoot, ".pideck-archive", "index.json"), "utf8"));
		const originals = Object.values(index).map((value) => String(value).replace(/\\/g, "/").toLowerCase());
		assert.ok(
			originals.some((value) => value.endsWith("/parent.jsonl")),
			"父会话原路径要进索引",
		);
		assert.ok(
			originals.some((value) => value.endsWith("/child-flat.jsonl")),
			"平铺子代理原路径要进索引",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleting a parent trashes the flat subagent file as well", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-subtree-delete-"));
	const trashDir = join(home, "trash");
	mkdirSync(trashDir, { recursive: true });
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const projectDir = join(sessionsRoot, "-proj");
		const parentPath = join(projectDir, "parent.jsonl");
		const flatPath = join(projectDir, "child-flat.jsonl");
		const nestedPath = join(projectDir, "parent", "child-nested.jsonl");
		writeSession(parentPath, sessionEntries("parent0001", "C:\\proj"));
		writeSession(flatPath, sessionEntries("flat000001", "C:\\proj", { parentSession: parentPath, name: "explore#a1b2c3d4" }));
		writeSession(nestedPath, sessionEntries("nested0001", "C:\\proj", { parentSession: parentPath }));

		const { SessionScanner } = loadSessionScanner(home, {
			shell: { trashItem: async (path) => renameSync(path, join(trashDir, `${Date.now()}-${path.split(/[\\/]/).pop()}`)) },
		});
		const scanner = new SessionScanner();
		await scanner.list();
		const catalog = fakeCatalog({
			parentId: "parent",
			parentPath,
			children: [
				{ id: "flat", filePath: flatPath },
				{ id: "nested", filePath: nestedPath },
			],
		});

		await scanner.delete(parentPath);
		const failures = await runForScatteredSubtreeFiles({ catalog, sessionId: "parent", parentFilePath: parentPath, environment: "native", run: (filePath) => scanner.delete(filePath) });

		assert.equal(failures.length, 0, `平铺子代理删除不应失败：${failures.join(",")}`);
		assert.equal(existsSync(parentPath), false);
		assert.equal(existsSync(flatPath), false, "平铺子代理文件不应留在活动扫描目录");
		assert.equal(existsSync(nestedPath), false, "嵌套子会话应随 <stem>/ 目录一起进回收站");
		const trashed = readdirSync(trashDir).map((name) => name.replace(/^\d+-/, ""));
		assert.ok(trashed.includes("parent.jsonl"), `父会话应进回收站：${trashed.join(",")}`);
		assert.ok(trashed.includes("child-flat.jsonl"), `平铺子代理应进回收站：${trashed.join(",")}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a failing flat subagent file is reported instead of aborting the parent operation", async () => {
	const root = "/home/u/.pi/agent/sessions/-proj";
	const parentPath = `${root}/parent.jsonl`;
	const catalog = fakeCatalog({
		parentId: "parent",
		parentPath,
		children: [
			{ id: "flat", filePath: `${root}/child-flat.jsonl` },
			{ id: "other", filePath: `${root}/child-other.jsonl` },
		],
	});
	const attempted = [];
	const failures = await runForScatteredSubtreeFiles({
		catalog,
		sessionId: "parent",
		parentFilePath: parentPath,
		environment: "native",
		run: async (filePath) => {
			attempted.push(filePath);
			if (filePath.endsWith("child-flat.jsonl")) throw new Error("EBUSY");
		},
	});
	assert.deepEqual(attempted.length, 2, "一个文件失败不应拦住后面的文件");
	assert.equal(failures.length, 1, "失败路径要回传给调用方记日志");
	assert.equal(failures[0], `${root}/child-flat.jsonl`);
});
