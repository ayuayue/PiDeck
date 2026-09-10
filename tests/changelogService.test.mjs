import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	ChangelogService,
	buildChangelogUrls,
	countChangelogVersions,
	decodeAtomGitContentsResponse,
	looksLikeChangelog,
} = loadTsCommonJs("src/main/update/ChangelogService.ts");

/** 一份形态真实的 changelog 片段（本仓库实际格式：`## vX.Y.Z - 日期`）。 */
const REAL_CHANGELOG = `## v0.7.5-beta - 2026-09-09

### 🚀 新功能
- **侧栏会话悬浮预览卡片** — 悬停 1.5 秒弹出预览。

## v0.7.4 - 2026-09-08

### 🐛 修复
- **暗色模式选中态** — 改用 text-inverse。
`;

/**
 * AtomGit 对匿名请求的 /raw/ 路径实际返回的 HTML 壳（含 captcha 字样）。
 * 这是本服务最关键的一条回归：200 响应绝不等于拿到内容。
 */
const ATOMGIT_CAPTCHA_HTML = `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8">
    <title>captcha</title>
  </head>
  <body><div id="app"></div></body>
</html>`;

function jsonResponse(body, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer,
	};
}

/** AtomGit OpenAPI contents 响应替身：markdown 按 base64 编码装进 JSON。 */
function atomgitContentsResponse(markdown, { status = 200 } = {}) {
	return jsonResponse(
		JSON.stringify({
			type: "file",
			encoding: "base64",
			content: Buffer.from(markdown, "utf8").toString("base64"),
		}),
		{ status },
	);
}

/** OpenAPI contents 接口的匿名 URL（与 buildChangelogUrls 的拼法保持一致）。 */
const ATOMGIT_API_URL =
	"https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/CHANGELOG.zh-CN.md?ref=main";
const GITHUB_RAW_URL =
	"https://raw.githubusercontent.com/ayuayue/PiDeck/main/CHANGELOG.zh-CN.md";

/** 按 URL 分派响应的 fetch 替身；未列出的 URL 抛网络错。 */
function fetchByUrl(map, calls = []) {
	return async (url, init) => {
		calls.push(String(url));
		const handler = map[String(url)];
		if (!handler) throw new Error(`unexpected fetch: ${url}`);
		return typeof handler === "function" ? handler(init) : handler;
	};
}

test("looksLikeChangelog accepts real markdown and rejects HTML shells", () => {
	assert.equal(looksLikeChangelog(REAL_CHANGELOG), true);
	// AtomGit 反爬页：即使 HTTP 200 也必须拒
	assert.equal(looksLikeChangelog(ATOMGIT_CAPTCHA_HTML), false);
	assert.equal(looksLikeChangelog(""), false);
	assert.equal(looksLikeChangelog("short"), false);
	// 大小写不敏感的前缀判断
	assert.equal(looksLikeChangelog("<!DOCTYPE html><html>captcha</html>"), false);
	// 正文里提到 HTML 不该被误杀（只查开头，不查全文）
	assert.equal(
		looksLikeChangelog(`${REAL_CHANGELOG}\n- 修复 <html> 标签渲染问题\n`),
		true,
	);
});

test("countChangelogVersions counts ## vX.Y.Z headings", () => {
	assert.equal(countChangelogVersions(REAL_CHANGELOG), 2);
	assert.equal(countChangelogVersions("# 没有版本条目"), 0);
});

test("buildChangelogUrls prefers AtomGit by default and GitHub when source is github", () => {
	const zh = buildChangelogUrls({ source: "atomgit", branch: "main", language: "zh" });
	assert.equal(zh.length, 2);
	assert.equal(zh[0].id, "atomgit");
	assert.equal(zh[1].id, "github");
	// atomgit 必须走 OpenAPI contents 接口（匿名 raw 已被 GitCode SPA 接管拿不到文件），
	// 且带 ref 参数；GitHub 保持 raw 直链。
	assert.match(zh[0].url, /^https:\/\/api\.atomgit\.com\/api\/v5\/repos\/ayuayue\/PiDeck\/contents\//);
	assert.match(zh[0].url, /CHANGELOG\.zh-CN\.md\?ref=main$/);
	assert.doesNotMatch(zh[0].url, /\/raw\//);
	assert.match(zh[1].url, /^https:\/\/raw\.githubusercontent\.com\/ayuayue\/PiDeck\/main\/CHANGELOG\.zh-CN\.md$/);

	// 用户显式选官方源：GitHub 提前
	const gh = buildChangelogUrls({ source: "github", branch: "main", language: "zh" });
	assert.equal(gh[0].id, "github");

	// 英文取 CHANGELOG.md（无 .zh-CN 后缀）
	const en = buildChangelogUrls({ source: "atomgit", branch: "main", language: "en" });
	assert.match(en[0].url, /contents\/CHANGELOG\.md\?ref=main$/);
	assert.doesNotMatch(en[0].url, /zh-CN/);
});

test("decodeAtomGitContentsResponse decodes base64 content and rejects bad shapes", () => {
	// 中文 + emoji 的 base64 往返
	const decoded = decodeAtomGitContentsResponse(
		JSON.stringify({
			type: "file",
			encoding: "base64",
			content: Buffer.from("## v1.0.0 🚀 新功能", "utf8").toString("base64"),
		}),
	);
	assert.equal(decoded, "## v1.0.0 🚀 新功能");
	// base64 序列里带换行（部分实现会分行）也能解
	assert.equal(
		decodeAtomGitContentsResponse(
			JSON.stringify({
				type: "file",
				encoding: "base64",
				content: Buffer.from(REAL_CHANGELOG, "utf8")
					.toString("base64")
					.replace(/(.{40})/g, "$1\n"),
			}),
		),
		REAL_CHANGELOG,
	);
	// 非法 JSON → 抛错（由逐源 try/catch 吞掉并回退）
	assert.throws(() => decodeAtomGitContentsResponse(ATOMGIT_CAPTCHA_HTML));
	// 形态不对（不是 file / 缺 content）→ 抛错
	assert.throws(() =>
		decodeAtomGitContentsResponse(JSON.stringify({ type: "dir", content: "" })),
	);
	assert.throws(() => decodeAtomGitContentsResponse(JSON.stringify({ message: "Not Found" })));
});

/**
 * 主路径：AtomGit OpenAPI 返回真实内容时直接成功（base64 正确解码为 UTF-8），
 * 不再回退 GitHub。
 */
test("ChangelogService decodes the AtomGit OpenAPI response without falling back", async () => {
	const calls = [];
	const service = new ChangelogService({
		source: () => "atomgit",
		fetchImpl: fetchByUrl({ [ATOMGIT_API_URL]: atomgitContentsResponse(REAL_CHANGELOG) }, calls),
	});

	const result = await service.getChangelog("zh");
	assert.ok(result, "atomgit OpenAPI 应直接命中");
	assert.equal(result.source, "atomgit");
	assert.equal(result.versionCount, 2);
	assert.match(result.markdown, /v0\.7\.5-beta/);
	assert.match(result.markdown, /🚀|新功能/);
	assert.equal(calls.length, 1, "不应触发 GitHub 回退");
});

/**
 * 核心回归：AtomGit 拿不到合法内容时必须回退 GitHub，不能把垃圾当 markdown。
 * 覆盖两种失败形态——API 被接成 HTML 壳（JSON 解析失败）、API 返回合法 JSON
 * 但解码内容是拦截页（内容校验拒绝）。
 */
test("ChangelogService falls back to GitHub when AtomGit returns unusable content", async () => {
	for (const atomgitResponse of [
		// 形态一：/raw/ 时代的老问题——SPA HTML 壳（对 API 而言是 JSON 解析失败）
		jsonResponse(ATOMGIT_CAPTCHA_HTML),
		// 形态二：JSON 合法但解码后是拦截页（内容校验拒绝）
		atomgitContentsResponse(ATOMGIT_CAPTCHA_HTML),
	]) {
		const calls = [];
		const service = new ChangelogService({
			source: () => "atomgit",
			fetchImpl: fetchByUrl(
				{
					[ATOMGIT_API_URL]: atomgitResponse,
					[GITHUB_RAW_URL]: jsonResponse(REAL_CHANGELOG),
				},
				calls,
			),
		});

		const result = await service.getChangelog("zh");
		assert.ok(result, "应回退到 GitHub 并拿到内容");
		assert.equal(result.source, "github");
		assert.equal(result.versionCount, 2);
		assert.match(result.markdown, /v0\.7\.5-beta/);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /api\.atomgit\.com/);
		assert.match(calls[1], /raw\.githubusercontent\.com/);
	}
});

test("ChangelogService returns null when every source fails", async () => {
	const service = new ChangelogService({
		source: () => "atomgit",
		fetchImpl: fetchByUrl({
			[ATOMGIT_API_URL]: () => {
				throw new Error("network down");
			},
			[GITHUB_RAW_URL]: jsonResponse("", { status: 404 }),
		}),
	});

	assert.equal(await service.getChangelog("zh"), null);
});

test("ChangelogService rejects oversized responses instead of buffering them", async () => {
	const huge = `${REAL_CHANGELOG}${"x".repeat(4_000)}`;
	const service = new ChangelogService({
		source: () => "atomgit",
		maxBytes: 1_000,
		fetchImpl: fetchByUrl({
			[ATOMGIT_API_URL]: atomgitContentsResponse(huge),
			[GITHUB_RAW_URL]: jsonResponse(REAL_CHANGELOG),
		}),
	});

	const result = await service.getChangelog("zh");
	// 超大响应被拒 → 回退 GitHub 正常返回
	assert.ok(result);
	assert.equal(result.source, "github");
});

test("ChangelogService aborts a hung request via the timeout instead of hanging", async () => {
	const service = new ChangelogService({
		source: () => "atomgit",
		timeoutMs: 30,
		fetchImpl: (_url, init) =>
			new Promise((_resolve, reject) => {
				// 模拟挂起：只在 abort 信号触发时拒绝，验证超时确实生效
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			}),
	});

	// 两个源都挂起 → 最终返回 null，而不是永远挂住
	assert.equal(await service.getChangelog("zh"), null);
});

test("changelogPageUrl points at the AtomGit blob page for the fallback link", () => {
	const service = new ChangelogService({ branch: "main" });
	assert.equal(
		service.changelogPageUrl("zh"),
		"https://atomgit.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md",
	);
	assert.equal(
		service.changelogPageUrl("en"),
		"https://atomgit.com/ayuayue/PiDeck/blob/main/CHANGELOG.md",
	);
});
