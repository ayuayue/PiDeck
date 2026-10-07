import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MCP_SERVICE_CATALOG, buildCatalogDefinition, catalogNeedsCredential } = loadTsCommonJs("src/renderer/src/config/mcpServiceCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("MCP service catalog ships the verified first batch with categories and unique ids", () => {
	const ids = Array.from(MCP_SERVICE_CATALOG, (entry) => entry.id);
	assert.deepEqual(ids, ["context7", "playwright", "chrome-devtools", "github", "sentry", "supabase", "linear", "notion", "brave-search", "firecrawl", "figma"]);
	assert.equal(new Set(ids).size, ids.length);
	for (const entry of MCP_SERVICE_CATALOG) {
		assert.ok(["dev", "work", "search", "design"].includes(entry.category), `${entry.id} category`);
		assert.match(entry.docsUrl, /^https:\/\//);
		assert.match(entry.titleKey, /^config\.mcp\.catalog\./);
	}
});

test("auth kind, credential target, and requiredness are declared consistently", () => {
	const byId = Object.fromEntries(MCP_SERVICE_CATALOG.map((entry) => [entry.id, entry]));
	// OAuth 服务（Linear/Notion/Sentry/Supabase/Figma）：无凭据字段，交给 pi 的 MCP OAuth 登录流。
	for (const id of ["linear", "notion", "sentry", "supabase", "figma"]) {
		assert.equal(byId[id].auth, "oauth", id);
		assert.equal(catalogNeedsCredential(byId[id]), false, id);
		assert.equal(byId[id].credential, undefined, id);
	}
	// 无认证服务（Playwright/Chrome DevTools）：只写传输字段。
	for (const id of ["playwright", "chrome-devtools"]) {
		assert.equal(byId[id].auth, "none", id);
		assert.equal(byId[id].credential, undefined, id);
	}
	// 必填密钥：GitHub（Bearer 头）与 Brave（env）。
	assert.equal(catalogNeedsCredential(byId.github), true);
	assert.deepEqual(plain(byId.github.credential), { kind: "header", header: "Authorization", scheme: "Bearer" });
	assert.equal(catalogNeedsCredential(byId["brave-search"]), true);
	assert.deepEqual(plain(byId["brave-search"].credential), { kind: "env", envKey: "BRAVE_API_KEY" });
	// 可选密钥（keyless 有额度限制）：Context7 与 Firecrawl。
	assert.equal(byId.context7.credentialOptional, true);
	assert.equal(catalogNeedsCredential(byId.context7), false);
	assert.equal(byId.firecrawl.credentialOptional, true);
	assert.equal(catalogNeedsCredential(byId.firecrawl), false);
});

test("buildCatalogDefinition writes trimmed credentials only into the declared target", () => {
	const byId = Object.fromEntries(MCP_SERVICE_CATALOG.map((entry) => [entry.id, entry]));
	// GitHub：Bearer 头，且不携带其他认证字段。
	const github = plain(buildCatalogDefinition(byId.github, "  ghp-token  "));
	assert.deepEqual(github, { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp-token" } });
	assert.equal(Object.hasOwn(github, "env"), false);
	// Brave：只写 BRAVE_API_KEY 环境变量，命令与参数原样来自 base。
	const brave = plain(buildCatalogDefinition(byId["brave-search"], "  key-1  "));
	assert.deepEqual(brave.env, { BRAVE_API_KEY: "key-1" });
	assert.deepEqual(brave.args, ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"]);
	assert.equal(Object.hasOwn(brave, "headers"), false);
	// OAuth/none：无凭据输入，直接落 base。
	assert.deepEqual(plain(buildCatalogDefinition(byId.linear, "")), { url: "https://mcp.linear.app/mcp" });
	assert.deepEqual(plain(buildCatalogDefinition(byId.playwright, "")), { command: "npx", args: ["@playwright/mcp@latest"] });
	// 可选密钥留空：回到 keyless 基础定义。
	assert.deepEqual(plain(buildCatalogDefinition(byId.context7, "   ")), { url: "https://mcp.context7.com/mcp" });
	// 可选密钥填写：合并进 headers，不覆盖 base 的其他头（这里 base 无其他头）。
	assert.deepEqual(plain(buildCatalogDefinition(byId.firecrawl, "fc-key")).headers, { Authorization: "Bearer fc-key" });
});

test("brand icons cover every catalog entry except the two without a simple-icons glyph", () => {
	const { MCP_BRAND_ICONS } = loadTsCommonJs("src/renderer/src/config/mcpServiceBrandIcons.tsx");
	const branded = new Set(Object.keys(MCP_BRAND_ICONS));
	// 目录 id → 品牌图标表：全部命中（无多余项）
	const ids = new Set(MCP_SERVICE_CATALOG.map((entry) => entry.id));
	for (const id of branded) assert.ok(ids.has(id), `orphan brand icon: ${id}`);
	// simple-icons 未收录：context7 / firecrawl 回退 lucide，其余 9 个都有品牌图标
	assert.deepEqual([...ids].filter((id) => !branded.has(id)).sort(), ["context7", "firecrawl"]);
	for (const [id, icon] of Object.entries(MCP_BRAND_ICONS)) {
		assert.match(icon.hex, /^#[0-9A-Fa-f]{6}$/, `${id} hex`);
		assert.match(icon.path, /^[Mm]/, `${id} svg path`);
	}
});

test("stdio entries carry the exact package names from the official docs", () => {
	const byId = Object.fromEntries(MCP_SERVICE_CATALOG.map((entry) => [entry.id, entry]));
	assert.deepEqual(plain(byId.playwright.base), { command: "npx", args: ["@playwright/mcp@latest"] });
	assert.deepEqual(plain(byId["chrome-devtools"].base), { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] });
});
