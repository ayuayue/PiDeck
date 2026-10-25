import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// searchNames 与 listTree 同属 FileSystemService 的纯 fs 行为：真实临时目录即可测，
// 不需要 mock node:fs。关注点：匹配语义、忽略规则、深度、symlink 安全、结果契约。
const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

/** 构造一个标准测试工作区：命中文件在根/嵌套/忽略目录三种位置 */
function createWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "pideck-search-"));
	writeFileSync(join(root, "AuthService.ts"), "export {}");
	writeFileSync(join(root, "README.md"), "# t");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "authService.ts"), "export {}");
	mkdirSync(join(root, "src", "deep", "nesting", "layer"), { recursive: true });
	writeFileSync(join(root, "src", "deep", "nesting", "layer", "auth-guard.ts"), "export {}");
	// 忽略目录：里面的命中文件必须不出现
	mkdirSync(join(root, "node_modules", "auth-pkg"), { recursive: true });
	writeFileSync(join(root, "node_modules", "auth-pkg", "auth.js"), "module.exports={}");
	// 大小写不同的目录命中
	mkdirSync(join(root, "Auth"));
	return root;
}

test("searchNames matches case-insensitive substring of file and directory names", async () => {
	const root = createWorkspace();
	try {
		const service = new FileSystemService();
		const results = await service.searchNames(root, "auth");

		const names = results.map((r) => `${r.type}:${r.relativePath}`);
		// 大小写不敏感子串：AuthService.ts / authService.ts / auth-guard.ts / Auth 目录都命中
		assert.ok(names.includes("file:AuthService.ts"), `missing AuthService.ts in ${names}`);
		assert.ok(names.includes("file:src/authService.ts"), `missing src/authService.ts in ${names}`);
		assert.ok(names.includes("file:src/deep/nesting/layer/auth-guard.ts"), `missing deep file in ${names}`);
		assert.ok(names.includes("directory:Auth"), `missing Auth dir in ${names}`);
		// 忽略目录内的命中必须被排除
		assert.ok(!names.some((n) => n.includes("node_modules")), `node_modules leaked: ${names}`);
		// 契约：path 为绝对路径且确实存在该文件名
		for (const r of results) {
			assert.equal(typeof r.path, "string");
			assert.ok(r.path.includes("auth") || r.path.includes("Auth"), `path mismatch: ${r.path}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("searchNames reaches files inside generated dirs shown in the drawer", async () => {
	// 树里能看到的文件必须搜得到；但构建产物排在源码目录之后，不能把有效命中挤掉。
	const root = mkdtempSync(join(tmpdir(), "pideck-search-generated-"));
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "build", "app-release.apk"), "x");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "app-main.ts"), "x");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "app-dep.js"), "x");
	try {
		const service = new FileSystemService();
		const results = await service.searchNames(root, "app");
		const relative = results.map((r) => r.relativePath);
		assert.ok(relative.includes("build/app-release.apk"), `generated file not searchable: ${relative}`);
		assert.ok(relative.includes("src/app-main.ts"), `source file missing: ${relative}`);
		// 源码命中必须排在构建产物之前（同层文件名排序内不约束，只看跨目录的先后）
		assert.ok(relative.indexOf("src/app-main.ts") < relative.indexOf("build/app-release.apk"), `generated dir should be scanned after source dirs: ${relative}`);
		assert.ok(!relative.some((path) => path.includes("node_modules")), `node_modules leaked: ${relative}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("searchNames skips symlinks to avoid cycles and false positives", async () => {
	const root = createWorkspace();
	// Windows 无特权创建符号链接会抛 EPERM：该平台降级为跳过此用例
	let canSymlink = true;
	try {
		symlinkSync(root, join(root, "src", "loop"));
	} catch {
		canSymlink = false;
	}
	try {
		if (canSymlink) {
			const service = new FileSystemService();
			// symlink 指向 root 自身：若有环 BFS 会在 deadline 前反复入队。这里只断言不炸且无重复结果
			const results = await service.searchNames(root, "auth");
			const paths = new Set(results.map((r) => r.path));
			assert.equal(paths.size, results.length);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("searchNames empty query returns empty list without scanning", async (t) => {
	// IPC 层已拦截空查询；服务层兜底语义：空查询返回空数组
	const root = createWorkspace();
	try {
		const service = new FileSystemService();
		const results = await service.searchNames(root, "   ");
		// 跨 realm（vm 加载的模块）数组原型不同，deepStrictEqual 会误报；长度断言等价
		assert.equal(results.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
