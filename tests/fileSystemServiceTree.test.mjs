import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// FileSystemService 直接依赖 node:fs/promises；node:test 环境可真实读临时目录，
// 这里验证 listTree 是否附加排序所需的 stat 元数据（mtimeMs/ctimeMs/size）。
const { FileSystemService, isPathInsideProject } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

test("WSL project containment preserves Linux path case", () => {
	const root = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo";
	assert.equal(isPathInsideProject(root, "//wsl$/ubuntu-24.04/root/Repo/src/a.ts"), true);
	assert.equal(isPathInsideProject(root, "//wsl$/ubuntu-24.04/root/repo/src/a.ts"), false);
	assert.equal(isPathInsideProject(root, "//wsl$/Debian/root/Repo/src/a.ts"), false);
});

test("native filesystem roots contain their descendants without doubling separators", () => {
	const nativeRoot = parse(tmpdir()).root;
	assert.equal(isPathInsideProject(nativeRoot, join(nativeRoot, "pideck-root-child")), true);
	if (process.platform === "win32") {
		assert.equal(isPathInsideProject("\\\\server\\share\\", "\\\\server\\share\\dir\\file.txt"), true);
	}
});

test("file tree nodes carry stat metadata for sorting", async () => {
	// 构造真实临时目录：两个文件（不同大小/时间）+ 一个子目录
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-"));
	const fileA = join(root, "a.txt");
	const fileB = join(root, "b.txt");
	writeFileSync(fileA, "aaaa"); // 4 字节
	writeFileSync(fileB, "bbbbbbbbbb"); // 10 字节
	const sub = join(root, "sub");
	mkdirSync(sub);
	const now = Date.now();
	utimesSync(fileA, new Date(now - 60_000), new Date(now - 60_000));
	utimesSync(fileB, new Date(now - 30_000), new Date(now - 30_000));

	try {
		const service = new FileSystemService();
		const tree = await service.listTree(root, 1);

		const byName = new Map(tree.map((n) => [n.name, n]));
		const fileANode = byName.get("a.txt");
		const fileBNode = byName.get("b.txt");
		const subNode = byName.get("sub");

		// 文件：size 为实际字节数，时间戳存在
		assert.equal(fileANode.size, 4);
		assert.equal(fileBNode.size, 10);
		assert.equal(typeof fileANode.mtimeMs, "number");
		assert.equal(typeof fileANode.ctimeMs, "number");
		// 更新时间可排序（b 更新）
		assert.ok(fileBNode.mtimeMs > fileANode.mtimeMs);
		// 目录：size 恒 0，时间戳仍存在（支持按时间排序）
		assert.equal(subNode.size, 0);
		assert.equal(typeof subNode.mtimeMs, "number");
		// 目录排在文件前（默认名称排序的既有契约不变）
		assert.equal(tree[0].name, "sub");
		assert.equal(subNode.hasChildren, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ignored names stay excluded from the tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-ignore-"));
	writeFileSync(join(root, "keep.ts"), "x");
	mkdirSync(join(root, "node_modules"));
	try {
		const service = new FileSystemService();
		const tree = await service.listTree(root, 1);
		const names = tree.map((n) => n.name);
		assert.ok(names.includes("keep.ts"));
		assert.ok(!names.includes("node_modules"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("browse listing shows generated dirs so users can find build output", async () => {
	// 文件抽屉是浏览工作区的入口：build/dist/target 必须可见，否则用户找不到自己生成的产物。
	// 同时 .git/node_modules 仍不可见（体量巨大且无浏览价值）。
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-generated-"));
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "build", "artifact.jar"), "x");
	mkdirSync(join(root, "dist"));
	mkdirSync(join(root, "target"));
	mkdirSync(join(root, "src", "build"), { recursive: true });
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "ignored"), "x");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "build.gradle.kts"), "x");
	try {
		const service = new FileSystemService();
		const tree = await service.listTree(root, 0);
		const names = tree.map((n) => n.name);
		assert.ok(names.includes("build"), `build dir missing in ${names}`);
		assert.ok(names.includes("dist"), `dist dir missing in ${names}`);
		assert.ok(names.includes("target"), `target dir missing in ${names}`);
		// 名字里带 build 的普通文件本来就不受忽略规则影响
		assert.ok(names.includes("build.gradle.kts"), `build.gradle.kts missing in ${names}`);
		assert.ok(!names.includes(".git"), `.git should stay hidden in ${names}`);
		assert.ok(!names.includes("node_modules"), `node_modules should stay hidden in ${names}`);
		// 浅层 listing 也要把产物目录标成可展开
		assert.equal(tree.find((node) => node.name === "build").hasChildren, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("composer @ scan skips generated dirs but keeps ordinary files", async () => {
	// @ 引用是整树扫描：深挖 build/target 里的 class/jar 既拖慢又污染候选，仍按旧行为跳过。
	// 只跳过目录本身，名字带 build 的文件（build.gradle.kts）照常出现。
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-scan-"));
	for (const dir of ["build", "dist", "target", ".next", "coverage", ".venv", "__pycache__", ".git", "node_modules"]) {
		mkdirSync(join(root, dir));
	}
	writeFileSync(join(root, "build.gradle.kts"), "x");
	writeFileSync(join(root, "keep.ts"), "x");
	try {
		const service = new FileSystemService();
		const scan = (await service.listTree(root, 0, undefined, { skipGeneratedDirs: true })).map((n) => n.name);
		for (const dir of ["build", "dist", "target", ".next", "coverage", ".venv", "__pycache__", ".git", "node_modules"]) {
			assert.ok(!scan.includes(dir), `${dir} should be skipped in @ scan: ${scan}`);
		}
		assert.ok(scan.includes("build.gradle.kts"), `build.gradle.kts missing in ${scan}`);
		assert.ok(scan.includes("keep.ts"), `keep.ts missing in ${scan}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shallow listing does not recurse and marks expandable directories", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-shallow-"));
	const nested = join(root, "src", "deep");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "a.ts"), "x");
	try {
		const service = new FileSystemService();
		const tree = await service.listTree(root, 0);
		const src = tree.find((node) => node.name === "src");
		assert.equal(src.type, "directory");
		assert.equal(src.children, undefined);
		assert.equal(src.hasChildren, true);

		const children = await service.listTree(root, 0, src.path);
		assert.equal(children[0].name, "deep");
		assert.equal(children[0].hasChildren, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listTree rejects a directory with too many direct children", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-huge-"));
	try {
		for (let index = 0; index < 2001; index += 1) {
			writeFileSync(join(root, `f-${index}.txt`), "x");
		}
		const service = new FileSystemService();
		await assert.rejects(() => service.listTree(root, 0), /FILE_TREE_DIRECTORY_TOO_LARGE/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listTree rejects a directory outside the project root", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-tree-escape-"));
	try {
		const service = new FileSystemService();
		await assert.rejects(() => service.listTree(root, 0, join(root, "..", "outside")), /escapes project directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
