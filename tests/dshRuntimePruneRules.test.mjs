import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allEntryCandidates, hasBuildOutput, isExcluded, isNpmHashedLeftoverDir, isSrcPrunable, runtimeEntryResolvableOnDisk } from "../scripts/runtime-prune-rules.mjs";

/**
 * DSH runtime 打包裁剪规则的回归测试。
 *
 * 背景（2026-08 生产事故）：规则里用 `docs?` 匹配文档目录，把 yaml 包的
 * 编译产物 `dist/doc/` 也裁掉了（composer.js 会 require('../doc/directives.js')），
 * host 启动即崩：Cannot find module '../doc/directives.js' → exit(1)。
 * 本文件把「doc/ 编译产物必须保留」钉死，防止回归。
 *
 * 后续事故（同一月）：入口感知 src 裁剪引入前，koffi 的 src/（运行时代码所在地）
 * 因 lib/ 存在被误裁，node-fetch 的 main 指向 src/ 也同理；isSrcPrunable 相关
 * 用例钉死「入口在 src/ 的包 / KEEP_SRC 白名单包必须保留 src/」。
 */

const noBuild = false;

test("裁剪规则：dist/lib/build 下的 doc/ 是编译产物，必须保留（yaml 事故回归）", () => {
	// yaml 实际被误裁的文件（打包脚本按相对包目录路径判定）
	assert.equal(isExcluded("dist/doc/directives.js", undefined, noBuild), false);
	assert.equal(isExcluded("dist/doc/Document.js", undefined, noBuild), false);
	assert.equal(isExcluded("dist/doc/anchors.js", undefined, noBuild), false);
	// browser 构建同样有 doc/ 编译产物
	assert.equal(isExcluded("browser/dist/doc/directives.js", undefined, noBuild), false);
});

test("裁剪规则：docs/（复数，文档惯例）仍然被裁", () => {
	assert.equal(isExcluded("docs/README.md", undefined, noBuild), true);
	assert.equal(isExcluded("dist/docs/api.md", undefined, noBuild), true);
});

test("裁剪规则：顶层 test/ spec/ examples/ demo/ 目录被裁", () => {
	assert.equal(isExcluded("test/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("spec/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("examples/demo.js", undefined, noBuild), true);
	assert.equal(isExcluded("demo/index.js", undefined, noBuild), true);
	assert.equal(isExcluded("__tests__/a.test.js", undefined, noBuild), true);
});

test("裁剪规则：调试符号/source map/类型声明/文档 md 被裁", () => {
	assert.equal(isExcluded("build/Release/x.pdb", undefined, noBuild), true);
	assert.equal(isExcluded("dist/index.js.map", undefined, noBuild), true);
	assert.equal(isExcluded("dist/index.d.ts", undefined, noBuild), true);
	assert.equal(isExcluded("README.md", undefined, noBuild), true);
	assert.equal(isExcluded("CHANGELOG.md", undefined, noBuild), true);
});

test("裁剪规则：有编译产物时 src/ 被裁，只有 src/ 时保留", () => {
	// hasBuildOutput 用真实目录判定，这里直接传 srcPrunable 参数
	assert.equal(isExcluded("src/index.ts", undefined, true), true);
	assert.equal(isExcluded("src/index.ts", undefined, false), false);
});

test("裁剪规则：third_party 与其他平台 prebuilds 被裁，当前平台保留", () => {
	assert.equal(isExcluded("third_party/old/index.js", undefined, noBuild), true);
	// linux 平台：linux prebuilds 保留、win32 的被裁
	assert.equal(isExcluded("prebuilds/linux-x64/x.node", undefined, noBuild, "linux"), false);
	assert.equal(isExcluded("prebuilds/win32-x64/x.node", undefined, noBuild, "linux"), true);
});

test("裁剪规则：LICENSE 与编译产物主体保留", () => {
	assert.equal(isExcluded("LICENSE", undefined, noBuild), false);
	assert.equal(isExcluded("dist/index.js", undefined, noBuild), false);
	assert.equal(isExcluded("lib/index.js", undefined, noBuild), false);
});

test("hasBuildOutput：按目录实测判定 src 是否可裁", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-prune-"));
	try {
		const withDist = join(root, "a");
		mkdirSync(join(withDist, "dist"), { recursive: true });
		assert.equal(hasBuildOutput(withDist), true);
		const srcOnly = join(root, "b");
		mkdirSync(join(srcOnly, "src"), { recursive: true });
		assert.equal(hasBuildOutput(srcOnly), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── isSrcPrunable：入口感知 src 裁剪（koffi/node-fetch 事故回归）──

function makePkg(root, name, { main, exports, dirs }) {
	const dir = join(root, name);
	for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main, exports }));
	return dir;
}

function makePruneFixture() {
	return mkdtempSync(join(tmpdir(), "dsh-prune-src-"));
}

test("isSrcPrunable：入口在 src/ 的包必须保留 src（node-fetch 事故）", () => {
	const root = makePruneFixture();
	try {
		// main 直接指向 src/index.js，即使有 lib/ 也不能裁
		const pkg = makePkg(root, "node-fetch", { main: "./src/index.js", dirs: ["src", "lib"] });
		assert.equal(hasBuildOutput(pkg), true);
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：exports 的 . 运行时条件指向 src/ 时保留 src", () => {
	const root = makePruneFixture();
	try {
		const pkg = makePkg(root, "x-export-src", {
			exports: { ".": { types: "./src/index.d.ts", default: "./src/index.js" } },
			dirs: ["src", "dist"],
		});
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：KEEP_SRC 白名单包（koffi）保留 src，即使入口在根目录", () => {
	const root = makePruneFixture();
	try {
		// koffi：main 在根 index.cjs（内部 require ./src/koffi/…），lib/ 只是原生二进制
		const pkg = makePkg(root, "koffi", { main: "./index.cjs", dirs: ["src", "lib"] });
		assert.equal(isSrcPrunable(pkg), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isNpmHashedLeftoverDir：只匹配 npm 升级残留的 .pkg-<8char> 目录", () => {
	// 活包名不以点开头，不会误伤；.bin 也不是 hashed leftover。
	assert.equal(isNpmHashedLeftoverDir(".dsh-base-cFJMOBFY"), true);
	assert.equal(isNpmHashedLeftoverDir(".dsh-attachment-local-UqFAktYy"), true);
	assert.equal(isNpmHashedLeftoverDir("dsh-base"), false);
	assert.equal(isNpmHashedLeftoverDir(".bin"), false);
	assert.equal(isNpmHashedLeftoverDir(".dsh-base-short"), false, "哈希段不足 8 位不是 npm leftover");
	assert.equal(isNpmHashedLeftoverDir(undefined), false);
});

test("runtimeEntryResolvableOnDisk：入口缺失可检出（file: 本地包未构建事故回归）", () => {
	const root = makePruneFixture();
	try {
		const pkg = makePkg(root, "unbuilt", {
			main: "./lib/index.js",
			exports: { ".": "./lib/index.js" },
			dirs: ["src"],
		});
		// lib/ 未构建（全新检出常态）：磁盘上解析不到
		assert.equal(runtimeEntryResolvableOnDisk(pkg, "./lib/index.js"), false);
		assert.equal(runtimeEntryResolvableOnDisk(pkg, "lib/index.js"), false);
		// 补齐编译产物后可解析（相当于自动构建成功后的复检）
		mkdirSync(join(pkg, "lib"), { recursive: true });
		writeFileSync(join(pkg, "lib", "index.js"), "");
		assert.equal(runtimeEntryResolvableOnDisk(pkg, "lib/index.js"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 子路径导出包（@modelcontextprotocol/sdk 场景）：exports["."] 指向从未发布的文件，
// 实际运行时只走子路径导出——入口候选必须收集 exports 整树，不能只看 "."。
test("allEntryCandidates：收集 exports 整树（含子路径），与 check-dsh-asar 同语义", () => {
	const root = makePruneFixture();
	try {
		const sdkLike = makePkg(root, "sdk-like", {
			main: undefined,
			exports: {
				".": {
					types: "./dist/esm/index.d.ts",
					import: "./dist/esm/index.js",
					require: "./dist/cjs/index.js",
				},
				"./client": {
					types: "./dist/esm/client/index.d.ts",
					import: "./dist/esm/client/index.js",
					require: "./dist/cjs/client/index.js",
				},
			},
			dirs: ["dist/esm/client", "dist/cjs/client"],
		});
		// 子路径导出的产物真实存在（"dist/esm/index.js" 按事故原型不发布）
		writeFileSync(join(sdkLike, "dist/esm/client", "index.js"), "");
		writeFileSync(join(sdkLike, "dist/cjs/client", "index.js"), "");
		const candidates = allEntryCandidates(sdkLike);
		// "." 的两个条件都收集到了（虽然文件不存在）
		assert.ok(candidates.includes("./dist/esm/index.js"));
		assert.ok(candidates.includes("./dist/cjs/index.js"));
		// 子路径导出条件也收集到，且可解析 → 全包不被误判为入口缺失
		assert.ok(candidates.includes("./dist/esm/client/index.js"));
		assert.ok(candidates.some((e) => runtimeEntryResolvableOnDisk(sdkLike, e)));

		// 纯类型数据包（@octokit/openapi-types 的 main: "" 且无 exports）→ 无入口候选
		const typesOnly = makePkg(root, "types-only", { main: "", dirs: ["types"] });
		assert.equal(allEntryCandidates(typesOnly).length, 0);

		// 2026-09 事故回归：exports 同时声明 "./package.json"（元数据导出）时，
		// 该候选必须被过滤——否则缺 lib/ 的坏包会被 package.json 误判为可解析。
		assert.ok(!candidates.includes("./package.json"));
		const brokenLike = makePkg(root, "broken-like", {
			main: "./lib/index.js",
			exports: { ".": "./lib/index.js", "./package.json": "./package.json" },
			dirs: ["src"],
		});
		assert.equal(
			allEntryCandidates(brokenLike).some((e) => runtimeEntryResolvableOnDisk(brokenLike, e)),
			false,
			"只有 package.json 可解析不能算数：缺 lib/ 必须被判定为入口缺失",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 无扩展名入口的补全规则：与 check-dsh-asar 的 resolveEntry 同语义
// （Node 会补 .js/.cjs/.mjs 与目录 index.*）。
test("runtimeEntryResolvableOnDisk：无扩展名/目录入口按 Node 规则补全", () => {
	const root = makePruneFixture();
	try {
		const extless = makePkg(root, "extless", { main: "dist/main", dirs: ["dist"] });
		mkdirSync(join(extless, "dist"), { recursive: true });
		writeFileSync(join(extless, "dist", "main.cjs"), "");
		assert.equal(runtimeEntryResolvableOnDisk(extless, "dist/main"), true);

		const indexDir = makePkg(root, "indexdir", { main: "dist", dirs: ["dist"] });
		mkdirSync(join(indexDir, "dist"), { recursive: true });
		writeFileSync(join(indexDir, "dist", "index.js"), "");
		assert.equal(runtimeEntryResolvableOnDisk(indexDir, "dist"), true);

		const emptyDir = makePkg(root, "emptydir", { main: "dist", dirs: ["dist"] });
		mkdirSync(join(emptyDir, "dist"), { recursive: true });
		assert.equal(runtimeEntryResolvableOnDisk(emptyDir, "dist"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isSrcPrunable：常规包（入口在 lib/dist）src 仍可裁；无编译产物不可裁", () => {
	const root = makePruneFixture();
	try {
		const normal = makePkg(root, "normal", { main: "./lib/index.js", dirs: ["src", "lib"] });
		assert.equal(isSrcPrunable(normal), true);
		const srcOnly = makePkg(root, "src-only", { main: "./src/index.js", dirs: ["src"] });
		assert.equal(isSrcPrunable(srcOnly), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
