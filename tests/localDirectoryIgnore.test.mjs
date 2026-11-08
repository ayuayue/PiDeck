import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { LocalProjectFileBackend } = loadTsCommonJs("src/main/files/LocalProjectFileBackend.ts");
const { GitService, readCheckIgnoreFlags } = loadTsCommonJs("src/main/git/GitService.ts");

/**
 * 本机目录页的 Git ignore 修饰（T6 收尾的第二半）。
 *
 * 契约与远端完全一致：只加 `ignored: true` 修饰；探测失败/未装配/不是仓库一律**不填**
 * （字段缺失 = 没判定，不是“未忽略”），目录页本身不因探测失败而失败。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function page(nodes) {
	return { nodes, truncated: false };
}

function backend(options = {}) {
	// resolveTarget 会对项目根做 realpath/边界检查：必须给一个真实存在的目录。
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pideck-local-ignore-"));
	const calls = [];
	const ledger = {
		listTreePage: async (root, maxDepth, directory) => {
			calls.push({ root, maxDepth, directory });
			return page([
				{ name: "dist", path: join(root, "dist"), relativePath: "dist", type: "directory", hasChildren: false },
				{ name: "a.txt", path: join(root, "a.txt"), relativePath: "a.txt", type: "file", hasChildren: false },
				{ name: "b.log", path: join(root, "b.log"), relativePath: "b.log", type: "file", hasChildren: false },
			]);
		},
	};
	const probeCalls = [];
	const factory = new LocalProjectFileBackend({
		fileSystemService: ledger,
		resolveProjectRoot: () => root,
		...(options.probe === "none"
			? {}
			: {
					checkIgnore: async (cwd, paths) => {
						probeCalls.push({ cwd, paths: [...paths] });
						if (options.probe === "throws") throw new Error("GIT_COMMAND_FAILED");
						if (options.probe === "undefined") return undefined;
						return paths.map((path) => path.endsWith(".log"));
					},
				}),
	});
	return { factory, calls, probeCalls, root };
}

test("本机目录页：ignored 只落在被忽略的条目上，探测按项目根批量一次", async () => {
	const f = backend();
	try {
		const result = await f.factory.directoryPage({ projectId: "p1", relativePath: "" });
		assert.equal(f.probeCalls.length, 1, "一次目录页只探测一次");
		assert.deepEqual(f.probeCalls[0].paths, ["dist", "a.txt", "b.log"], "顺序与条目一致");
		// Windows 上 realpath 会展开 8.3 短名：比较归一后的同一目录，而不是字符串原样。
		assert.equal(realpathSync.native(f.probeCalls[0].cwd), realpathSync.native(f.root), "探测 cwd 是项目根");
		const byPath = new Map(result.entries.map((entry) => [entry.relativePath, entry]));
		assert.equal(byPath.get("b.log").ignored, true);
		assert.equal(Object.hasOwn(byPath.get("a.txt"), "ignored"), false, "未被忽略 = 没有修饰，不是 false");
		assert.equal(Object.hasOwn(byPath.get("dist"), "ignored"), false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("本机目录页：探测失败/未装配/返回 undefined 都只丢修饰，页面仍然成功", async () => {
	for (const probe of ["throws", "none", "undefined"]) {
		const f = backend({ probe });
		try {
			const result = await f.factory.directoryPage({ projectId: "p1", relativePath: "" });
			assert.equal(result.entries.length, 3, probe);
			for (const entry of result.entries) assert.equal(Object.hasOwn(entry, "ignored"), false, probe + "：“没判定”不能写成“未忽略”");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test("readCheckIgnoreFlags：NUL 分隔输出逐位对应，多余/缺失都不猜", () => {
	assert.deepEqual(readCheckIgnoreFlags("b.log\0dist\0", ["dist", "a.txt", "b.log"]), [true, false, true]);
	assert.deepEqual(readCheckIgnoreFlags("", ["a.txt"]), [false], "exit 1（没有命中）就是全 false");
	assert.deepEqual(readCheckIgnoreFlags("b.log\0", []), []);
});

test("GitService.checkIgnore：真实 git 仓库逐位判定；非仓库返回 undefined", (t) => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
	} catch {
		t.skip("本机没有 git");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "pideck-ignore-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "*.log\ndist/\n");
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "a.txt"), "a\n");
		writeFileSync(join(root, "b.log"), "b\n");
		const service = new GitService();
		return service
			.checkIgnore(root, ["a.txt", "b.log", "dist"])
			.then((flags) => {
				assert.deepEqual(plain(flags), [false, true, true]);
			})
			.then(() => service.checkIgnore(tmpdir(), ["a.txt"]))
			.then((flags) => {
				assert.equal(flags, undefined, "不在仓库里：未知，不是“未忽略”");
			})
			.finally(() => rmSync(root, { recursive: true, force: true }));
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
});

test("ignore 结果按目录 5s 复用；写操作与 TTL 都会让它重判", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-local-ignore-cache-"));
	writeFileSync(join(root, "a.txt"), "a");
	let now = 1_000;
	const probeCalls = [];
	const factory = new LocalProjectFileBackend({
		fileSystemService: {
			listTreePage: async () => page([]),
			create: async () => undefined,
			delete: async () => undefined,
			rename: async () => undefined,
			searchNames: async () => [],
		},
		resolveProjectRoot: () => root,
		now: () => now,
		checkIgnore: async (_cwd, paths) => {
			probeCalls.push([...paths]);
			return paths.map(() => false);
		},
	});
	try {
		const target = { projectId: "p1", relativePath: "" };
		await factory.checkIgnore(target, ["a.txt"]);
		await factory.checkIgnore(target, ["a.txt"]);
		assert.equal(probeCalls.length, 1, "5s 内同目录同路径集只判一次");

		now += 6_000;
		await factory.checkIgnore(target, ["a.txt"]);
		assert.equal(probeCalls.length, 2, "TTL 过期后重判");

		// 写操作可能改 .gitignore：缓存必须作废，下一次重新判定。
		await factory.writeContent({ projectId: "p1", relativePath: "a.txt" }, "next");
		await factory.checkIgnore(target, ["a.txt"]);
		assert.equal(probeCalls.length, 3, "写操作清空 ignore 缓存");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
