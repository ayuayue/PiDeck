/**
 * AtomGit 仓库文件读取单测（URL 构造 + base64 信封解码 + 源顺序 + 防复辟 raw 直链）。
 *
 * 背景：`atomgit.com/<owner>/<repo>/raw/<ref>/<path>` 已被 GitCode 前端应用接管，
 * 程序化请求回来的是 SPA HTML 壳（+ 易盾验证码 SDK），解析必然失败——所以应用内所有
 * 「从仓库取文件」的通道（内置扩展/内置内容热更新、changelog、pi-ai 模型目录）统一改走
 * AtomGit OpenAPI contents（base64 信封）。这个测试锁住 URL 形态、解码语义与源顺序，
 * 并用源码扫描防止有人再拼一条 raw 直链。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { atomGitContentsApiUrl, gitHubRawFileUrl, repoFileSourceEntries, decodeAtomGitContentsBuffer, decodeAtomGitContentsResponse } = loadTsCommonJs("src/main/update/atomGitContents.ts");

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 构造 AtomGit contents 响应体（content 为 base64）。 */
function envelope(text, extra = {}) {
	return JSON.stringify({
		type: "file",
		encoding: "base64",
		content: Buffer.from(text, "utf8").toString("base64"),
		...extra,
	});
}

test("atomGitContentsApiUrl：路径按段编码保留斜杠，分支进 query 并编码", () => {
	assert.equal(atomGitContentsApiUrl("resources/extensions/pi-deck-todo.ts", "main"), "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/resources/extensions/pi-deck-todo.ts?ref=main");
	// 文件名带 # / 空格 / 中文时不能拼出坏 URL（# 会被当 fragment 截断路径）
	assert.equal(atomGitContentsApiUrl("docs/我的 文件#1.md", "main"), "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/docs/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6%231.md?ref=main");
	// 分支名带斜杠：必须编码进 query，不能泄进路径
	assert.ok(atomGitContentsApiUrl("README.md", "feat/x").endsWith("?ref=feat%2Fx"));
});

test("gitHubRawFileUrl：仍是 raw 直链（GitHub 侧未被前端接管）", () => {
	assert.equal(gitHubRawFileUrl("resources/pi-ai-catalog.json", "main"), "https://raw.githubusercontent.com/ayuayue/PiDeck/main/resources/pi-ai-catalog.json");
});

test("repoFileSourceEntries：github 源 raw 优先，其余源 AtomGit 优先，两条都在", () => {
	// 注意：模块经 vm 沙箱加载，其数组原型与测试域不同，deepEqual 会因 realm 不同而误报，故比字符串
	const githubFirst = repoFileSourceEntries("CHANGELOG.md", "main", "github");
	assert.equal(githubFirst.map((entry) => entry.id).join(","), "github,atomgit");
	assert.equal(githubFirst[0].url, gitHubRawFileUrl("CHANGELOG.md", "main"));
	assert.equal(githubFirst[1].url, atomGitContentsApiUrl("CHANGELOG.md", "main"));

	for (const source of ["atomgit", "custom"]) {
		const entries = repoFileSourceEntries("CHANGELOG.md", "main", source);
		assert.equal(entries.map((entry) => entry.id).join(","), "atomgit,github", `${source} 源应 AtomGit 优先`);
		// 源顺序只决定快慢：两个源始终同时存在，任一失败可换下一个
		assert.equal(entries.length, 2);
	}
});

test("decodeAtomGitContentsBuffer：base64 还原为同样的字节（含多字节字符）", () => {
	const text = "内置扩展：中文字符 ✅ ---\n";
	const bytes = decodeAtomGitContentsBuffer(envelope(text));
	assert.ok(Buffer.isBuffer(bytes));
	assert.equal(bytes.toString("utf8"), text);
	assert.equal(Buffer.compare(bytes, Buffer.from(text, "utf8")), 0, "字节应逐字节一致（sha256 按字节算）");
});

test("decodeAtomGitContentsBuffer：HTML / 目录 / 缺字段一律 null（交调用方换源）", () => {
	assert.equal(decodeAtomGitContentsBuffer("<!doctype html><html>GitCode</html>"), null);
	assert.equal(decodeAtomGitContentsBuffer(JSON.stringify({ type: "dir", content: "" })), null);
	assert.equal(decodeAtomGitContentsBuffer(JSON.stringify({ type: "file" })), null);
	assert.equal(decodeAtomGitContentsBuffer("null"), null);
	assert.equal(decodeAtomGitContentsBuffer("[1,2,3]"), null);
});

test("decodeAtomGitContentsResponse：正常解码，形态异常抛错（由调用方逐源兜底）", () => {
	assert.equal(decodeAtomGitContentsResponse(envelope("# 更新日志\n")), "# 更新日志\n");
	// base64 序列里的换行（部分网关会插入）不影响解码
	const wrapped = envelope("hello");
	const payload = JSON.parse(wrapped);
	const withNewlines = JSON.stringify({ ...payload, content: payload.content.replace(/(.{4})/g, "$1\n") });
	assert.equal(decodeAtomGitContentsResponse(withNewlines), "hello");

	assert.throws(() => decodeAtomGitContentsResponse("<!doctype html>"), /not valid JSON/);
	assert.throws(() => decodeAtomGitContentsResponse(JSON.stringify({ type: "dir", content: "" })), /unexpected shape/);
	assert.throws(() => decodeAtomGitContentsResponse(JSON.stringify({ type: "file", content: 42 })), /unexpected shape/);
});

// 回归守卫：raw 直链是错的（HTML 壳），任何再拼 host+raw 的写法都应被挡下。
test("源码里不再出现 `${host}/.../raw/` 形式的 AtomGit 拼接", () => {
	const rawPathPattern = /\$\{[^}]+\}\/[^`\s]*\/raw\//;
	const offenders = [];
	for (const dir of ["src/main", "src/shared"]) {
		for (const file of listTsFiles(join(repoRoot, dir))) {
			const source = readFileSync(file, "utf8");
			const match = source.match(rawPathPattern);
			if (match) offenders.push(`${file.replace(repoRoot, ".")}: ${match[0]}`);
		}
	}
	assert.deepEqual(offenders, [], `AtomGit 文件下载应统一走 contents API，实际仍有人拼 raw 直链: ${offenders.join(", ")}`);
});

/** 递归列出目录下的 .ts 文件（跳过 node_modules，正则扫描用）。 */
function listTsFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}
