import assert from "node:assert/strict";
import test from "node:test";
import { FILE_PATH_RE, extractFileLinkLocation, isAbsoluteFilePath, isFilePathInsideRoot, matchPlainFilePaths, normalizeFileLinkPath, resolveFileLinkPath } from "../src/renderer/src/utils/filePathLinks.ts";

// matchPlainFilePaths：markdown 文本 → 纯文本文件路径候选（带区间）。
// 这是「模型给的路径可能不存在」场景的第一道闸：只负责识别候选，
// 存在性校验交给 verdict store（files:paths-exist IPC）。

test("matches windows absolute, relative and ~ paths with spans", () => {
	const text = "请看 D:\\proj\\src\\a.ts 和 src/lib/b.ts，还有 ~/notes.md";
	const matches = matchPlainFilePaths(text);
	assert.deepEqual(
		matches.map((m) => m.path),
		["D:\\proj\\src\\a.ts", "src/lib/b.ts", "~/notes.md"],
	);
	for (const m of matches) {
		assert.equal(text.slice(m.start, m.end), m.path);
	}
});

test("skips url tails so links are not double-linkified", () => {
	const text = "文档在 https://example.com/docs/readme.md 里";
	assert.deepEqual(matchPlainFilePaths(text), []);
});

test("full-width punctuation and quotes are excluded from matches", () => {
	const text = "改了「src/app/main.tsx」，见（utils/fmt.ts）。";
	const matches = matchPlainFilePaths(text);
	assert.deepEqual(
		matches.map((m) => m.path),
		["src/app/main.tsx", "utils/fmt.ts"],
	);
});

test("regex rejects bare words without separators or dots", () => {
	assert.equal(FILE_PATH_RE.test("hello"), false);
	assert.equal(FILE_PATH_RE.test("src"), false);
});

// —— 无后缀目录 / 白名单无后缀文件（issue #229 第二项）——
// 识别只是候选，误报由存在性校验降级成纯文本；因此这里既锁正例也锁反例。

test("matches suffix-less directories, trailing slashes and whitelisted nameless files", () => {
	const text = "改 src/main/ipc 里的实现，看 src/renderer/src/components、docs/，读 Makefile 与 a/.gitignore";
	const matches = matchPlainFilePaths(text);
	assert.deepEqual(
		matches.map((m) => m.path),
		["src/main/ipc", "src/renderer/src/components", "docs/", "Makefile", "a/.gitignore"],
	);
	for (const m of matches) {
		assert.equal(text.slice(m.start, m.end), m.path);
	}
});

test("matches suffix-less absolute and home-relative directories", () => {
	const text = "看 C:\\proj\\src 和 /usr/local，还有 ~/dev/proj 与 ./src/utils";
	assert.deepEqual(
		matchPlainFilePaths(text).map((m) => m.path),
		["C:\\proj\\src", "/usr/local", "~/dev/proj", "./src/utils"],
	);
});

// 目录候选常常是文件路径的前缀：必须只产出一个「更长」的候选，否则能点击的链接会被截断。
test("directory candidates never truncate a longer file path", () => {
	assert.deepEqual(
		matchPlainFilePaths("路径是 C:\\proj\\src\\a.ts 文件").map((m) => m.path),
		["C:\\proj\\src\\a.ts"],
	);
	assert.deepEqual(
		matchPlainFilePaths("改 src/main/index.ts 与 docs/guide.md").map((m) => m.path),
		["src/main/index.ts", "docs/guide.md"],
	);
});

// 英文散文里的斜杠列表是目录识别最大的误报源：`and/` 后面还跟着字母 → 不算目录。
test("never linkifies slash lists from prose", () => {
	for (const text of ["and/or 关系", "N/A", "TCP/IP 协议", "CI/CD 流水线", "he/she", "A/B/C/ 这种", "他/她/它 都用", "24/7 全天候", "1/2/3 分数", "版本 2.0 发布"]) {
		assert.deepEqual(matchPlainFilePaths(text), [], text);
	}
});

// 单段无后缀词与英文单词无法区分 → 一律不识别（`src/main` 只有 1 个斜杠，与 `and/or` 同形）。
test("never linkifies bare words without extension or path shape", () => {
	for (const text of ["components 目录", "docs 目录", "改 src/main 目录", "xMakefile 不是", "Makefile.bak 备份", "a.env 不是"]) {
		assert.deepEqual(matchPlainFilePaths(text), [], text);
	}
});

test("isAbsoluteFilePath covers win drive, posix root and tilde only", () => {
	assert.equal(isAbsoluteFilePath("D:\\a\\b.ts"), true);
	assert.equal(isAbsoluteFilePath("/usr/local/a.ts"), true);
	assert.equal(isAbsoluteFilePath("~/a.ts"), true);
	assert.equal(isAbsoluteFilePath("\\\\server\\share\\a.ts"), true);
	assert.equal(isAbsoluteFilePath("src/a.ts"), false);
	assert.equal(isAbsoluteFilePath("https://x.com"), false);
});

test("extractFileLinkLocation splits path and line/column markers", () => {
	assert.deepEqual(extractFileLinkLocation("/C:/Users/Test/project/src/App.tsx:392"), {
		path: "C:/Users/Test/project/src/App.tsx",
		line: 392,
	});
	assert.deepEqual(extractFileLinkLocation("/home/u/project/src/app.py:12:4"), {
		path: "/home/u/project/src/app.py",
		line: 12,
		column: 4,
	});
	assert.deepEqual(extractFileLinkLocation("src/main/index.ts"), { path: "src/main/index.ts" });
	assert.deepEqual(extractFileLinkLocation("C%3A%2FUsers%2FTest%2FMy%20File.ts%3A9"), {
		path: "C:/Users/Test/My File.ts",
		line: 9,
	});
	// normalizeFileLinkPath 与 extract 的 path 永远一致
	assert.equal(normalizeFileLinkPath("/C:/Users/Test/a.ts:42"), extractFileLinkLocation("/C:/Users/Test/a.ts:42").path);
});

test("normalizes Markdown Windows file URLs and strips line locations", () => {
	assert.equal(normalizeFileLinkPath("/C:/Users/Test/project/src/App.tsx:392"), "C:/Users/Test/project/src/App.tsx");
	assert.equal(normalizeFileLinkPath("/home/user/project/src/app.py:12:4"), "/home/user/project/src/app.py");
	assert.equal(normalizeFileLinkPath("C%3A%2FUsers%2FTest%2FMy%20File.ts%3A9"), "C:/Users/Test/My File.ts");
	assert.equal(resolveFileLinkPath("/C:/Users/Test/project/src/App.tsx:392"), "C:\\Users\\Test\\project\\src\\App.tsx");
});

test("resolveFileLinkPath joins relatives against base with matching separator and passes absolutes through", () => {
	assert.equal(resolveFileLinkPath("src\\a.ts", "D:\\proj"), "D:\\proj\\src\\a.ts");
	assert.equal(resolveFileLinkPath("src/a.ts", "/home/u/proj"), "/home/u/proj/src/a.ts");
	assert.equal(resolveFileLinkPath("src/a.ts", "D:\\proj"), "D:\\proj\\src\\a.ts");
	// 绝对路径与 ~ 路径不需要 base
	assert.equal(resolveFileLinkPath("C:\\temp\\x.log", undefined), "C:\\temp\\x.log");
	assert.equal(resolveFileLinkPath("/tmp/x.log", "D:\\proj"), "/tmp/x.log");
	assert.equal(resolveFileLinkPath("~/x.log", undefined), "~/x.log");
	// 无 base 的相对路径无从解析：返回 null（调用方按未知处理）
	assert.equal(resolveFileLinkPath("src/a.ts", undefined), null);
});

test("two session panes resolve the same relative tool path against their own cwd", () => {
	assert.equal(resolveFileLinkPath("src/index.ts", "D:\\work\\left", "D:\\work\\left"), "D:\\work\\left\\src\\index.ts");
	assert.equal(resolveFileLinkPath("src/index.ts", "D:\\work\\right", "D:\\work\\right"), "D:\\work\\right\\src\\index.ts");
});

test("project-scoped resolution normalizes dot segments and rejects traversal or foreign absolutes", () => {
	assert.equal(resolveFileLinkPath("src/./feature/../index.ts", "D:\\work\\app", "D:\\work\\app"), "D:\\work\\app\\src\\index.ts");
	assert.equal(resolveFileLinkPath("../secret.txt", "D:\\work\\app", "D:\\work\\app"), null);
	assert.equal(resolveFileLinkPath("D:\\work\\other\\secret.txt", "D:\\work\\app", "D:\\work\\app"), null);
	// 前缀相同不等于位于根内；Windows 比较按平台语义忽略大小写。
	assert.equal(isFilePathInsideRoot("D:\\work\\application\\a.ts", "D:\\work\\app"), false);
	assert.equal(isFilePathInsideRoot("d:\\WORK\\APP\\src\\a.ts", "D:\\work\\app"), true);
	assert.equal(resolveFileLinkPath("\\\\server\\share\\src\\a.ts", undefined, "\\\\server\\share"), "\\\\server\\share\\src\\a.ts");
	// POSIX 项目仍区分大小写。
	assert.equal(isFilePathInsideRoot("/work/App/a.ts", "/work/app"), false);
});

test("WSL runtime paths align with the ProjectStore UNC root before containment checks", () => {
	const root = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo";
	assert.equal(resolveFileLinkPath("src/index.ts", "/root/Repo", root), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo\\src\\index.ts");
	assert.equal(resolveFileLinkPath("/root/Repo/src/index.ts", undefined, root), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo\\src\\index.ts");
	assert.equal(resolveFileLinkPath("//wsl$/ubuntu-24.04/root/Repo/src/index.ts", undefined, root), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo\\src\\index.ts");
	assert.equal(resolveFileLinkPath("/root/other/secret.txt", undefined, root), null);
	assert.equal(resolveFileLinkPath("//wsl.localhost/Debian/root/Repo/src/index.ts", undefined, root), null);
});

test("WSL containment ignores host and distro case but preserves Linux path case", () => {
	const root = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo";
	assert.equal(isFilePathInsideRoot("//WSL$/ubuntu-24.04/root/Repo/src/a.ts", root), true);
	assert.equal(isFilePathInsideRoot("//wsl$/ubuntu-24.04/root/repo/src/a.ts", root), false);
});
