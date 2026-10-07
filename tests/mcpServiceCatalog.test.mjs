import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MCP_SERVICE_CATALOG, buildCatalogDefinition, catalogNeedsCredential } = loadTsCommonJs("src/renderer/src/config/mcpServiceCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const byId = Object.fromEntries(MCP_SERVICE_CATALOG.map((entry) => [entry.id, entry]));

test("MCP service catalog ships the verified batches (intl + CN) with categories and unique ids", () => {
	const ids = Array.from(MCP_SERVICE_CATALOG, (entry) => entry.id);
	assert.deepEqual(ids, ["context7", "modelscope", "playwright", "chrome-devtools", "github", "sentry", "supabase", "linear", "notion", "lark", "dingtalk", "alipay", "amap", "tencent-map", "rail12306", "brave-search", "firecrawl", "figma"]);
	assert.equal(new Set(ids).size, ids.length);
	for (const entry of MCP_SERVICE_CATALOG) {
		assert.ok(["dev", "work", "maps", "search", "design"].includes(entry.category), `${entry.id} category`);
		assert.match(entry.docsUrl, /^https:\/\//);
		assert.match(entry.titleKey, /^config\.mcp\.catalog\./);
	}
});

test("auth kind, credential fields, and requiredness are declared consistently", () => {
	// OAuth 服务：无凭据字段，交给 pi 的 MCP OAuth 登录流。
	for (const id of ["linear", "notion", "sentry", "supabase", "figma"]) {
		assert.equal(byId[id].auth, "oauth", id);
		assert.equal(catalogNeedsCredential(byId[id]), false, id);
		assert.equal(byId[id].credentials, undefined, id);
	}
	// 无认证服务（Playwright/Chrome DevTools/12306）：只写传输字段。
	for (const id of ["playwright", "chrome-devtools", "rail12306"]) {
		assert.equal(byId[id].auth, "none", id);
		assert.equal(byId[id].credentials, undefined, id);
	}
	// 单凭据必填：GitHub（Bearer 头）与 Brave（env）。
	assert.equal(catalogNeedsCredential(byId.github), true);
	assert.equal(byId.github.credentials.length, 1);
	assert.deepEqual(plain(byId.github.credentials[0].credential), { kind: "header", header: "Authorization", scheme: "Bearer" });
	assert.equal(catalogNeedsCredential(byId["brave-search"]), true);
	assert.deepEqual(plain(byId["brave-search"].credentials[0].credential), { kind: "env", envKey: "BRAVE_API_KEY" });
	// 可选密钥（keyless 有额度限制）：Context7 与 Firecrawl。
	assert.equal(byId.context7.credentials[0].optional, true);
	assert.equal(catalogNeedsCredential(byId.context7), false);
	assert.equal(byId.firecrawl.credentials[0].optional, true);
	assert.equal(catalogNeedsCredential(byId.firecrawl), false);
	// 多凭据必填：飞书（args 双字段）、钉钉（env 双字段）、支付宝（env 三字段）。
	assert.equal(catalogNeedsCredential(byId.lark), true);
	assert.deepEqual(
		plain(byId.lark.credentials).map((field) => field.credential),
		[
			{ kind: "args", flag: "-a" },
			{ kind: "args", flag: "-s" },
		],
	);
	assert.deepEqual(
		plain(byId.dingtalk.credentials).map((field) => field.credential),
		[
			{ kind: "env", envKey: "DINGTALK_Client_ID" },
			{ kind: "env", envKey: "DINGTALK_Client_Secret" },
		],
	);
	assert.deepEqual(
		plain(byId.alipay.credentials).map((field) => field.credential),
		[
			{ kind: "env", envKey: "AP_APP_ID" },
			{ kind: "env", envKey: "AP_APP_KEY" },
			{ kind: "env", envKey: "AP_PUB_KEY" },
		],
	);
	// URL 参数凭据：高德与腾讯地图（key 拼进 URL query）。
	assert.deepEqual(plain(byId.amap.credentials[0].credential), { kind: "url-query", param: "key" });
	assert.deepEqual(plain(byId["tencent-map"].credentials[0].credential), { kind: "url-query", param: "key" });
	assert.equal(catalogNeedsCredential(byId.amap), true);
});

test("buildCatalogDefinition writes each credential into its declared target", () => {
	// GitHub：Bearer 头，且不携带其他认证字段。
	const github = plain(buildCatalogDefinition(byId.github, ["  ghp-token  "]));
	assert.deepEqual(github, { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp-token" } });
	assert.equal(Object.hasOwn(github, "env"), false);
	// Brave：只写 BRAVE_API_KEY 环境变量，命令与参数原样来自 base。
	const brave = plain(buildCatalogDefinition(byId["brave-search"], ["  key-1  "]));
	assert.deepEqual(brave.env, { BRAVE_API_KEY: "key-1" });
	assert.deepEqual(brave.args, ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"]);
	// 高德：key 拼进 URL query。
	assert.deepEqual(plain(buildCatalogDefinition(byId.amap, ["amap-key-1"])), { url: "https://mcp.amap.com/mcp?key=amap-key-1" });
	// 飞书：凭据按 -a/-s 追加到 args。
	const lark = plain(buildCatalogDefinition(byId.lark, ["cli_a1", "sec_b2"]));
	assert.deepEqual(lark.args, ["-y", "@larksuiteoapi/lark-mcp", "mcp", "-a", "cli_a1", "-s", "sec_b2"]);
	// 钉钉：双 env 同时写入。
	const dingtalk = plain(buildCatalogDefinition(byId.dingtalk, ["id-1", "secret-2"]));
	assert.deepEqual(dingtalk.env, { DINGTALK_Client_ID: "id-1", DINGTALK_Client_Secret: "secret-2" });
	// 可选密钥留空：回到 keyless 基础定义；空值字段被跳过、非空字段照常写入。
	assert.deepEqual(plain(buildCatalogDefinition(byId.context7, [""])), { url: "https://mcp.context7.com/mcp" });
	const larkPartial = plain(buildCatalogDefinition(byId.lark, ["cli_a1", " "]));
	assert.equal(larkPartial.args.includes("-s"), false, "empty optional-style field skipped");
});

test("brand icons cover every catalog entry except the documented fallbacks", () => {
	const { MCP_BRAND_ICONS } = loadTsCommonJs("src/renderer/src/config/mcpServiceBrandIcons.tsx");
	const branded = new Set(Object.keys(MCP_BRAND_ICONS));
	const ids = new Set(MCP_SERVICE_CATALOG.map((entry) => entry.id));
	for (const id of branded) assert.ok(ids.has(id), `orphan brand icon: ${id}`);
	// simple-icons 未收录的服务回退 lucide（官方未收录则不硬造 logo）；钉钉/飞书用 ant-design / 飞书官方 CDN 图形
	const fallbacks = [...ids].filter((id) => !branded.has(id)).sort();
	assert.deepEqual(fallbacks, ["amap", "context7", "firecrawl", "rail12306", "tencent-map"]);
	for (const [id, icon] of Object.entries(MCP_BRAND_ICONS)) {
		assert.match(icon.hex, /^#[0-9A-Fa-f]{6}$/, `${id} hex`);
		if (icon.multiPaths) {
			// 官方彩色多 path：每段自带 fill，不再需要单色 path
			assert.ok(icon.multiPaths.length >= 2, `${id} multiPaths count`);
			for (const segment of icon.multiPaths) {
				assert.match(segment.d, /^[Mm]/, `${id} multiPath d`);
				assert.match(segment.fill, /^#[0-9A-Fa-f]{6}$/, `${id} multiPath fill`);
			}
		} else {
			assert.match(icon.path ?? "", /^[Mm]/, `${id} svg path`);
		}
		if (icon.viewSize !== undefined) assert.ok([16, 48, 1024].includes(icon.viewSize), `${id} viewSize`);
	}
});

test("stdio entries carry the exact package names from the official docs", () => {
	assert.deepEqual(plain(byId.playwright.base), { command: "npx", args: ["@playwright/mcp@latest"] });
	assert.deepEqual(plain(byId["chrome-devtools"].base), { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] });
	assert.deepEqual(plain(byId.rail12306.base), { command: "npx", args: ["-y", "12306-mcp"] });
	assert.deepEqual(plain(byId.modelscope.base), { command: "uvx", args: ["modelscope-mcp-server"] });
	assert.deepEqual(plain(byId.lark.base), { command: "npx", args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"] });
	assert.deepEqual(plain(byId.dingtalk.base), { command: "npx", args: ["-y", "dingtalk-mcp@latest"] });
	assert.deepEqual(plain(byId.alipay.base), { command: "npx", args: ["-y", "@alipay/mcp-server-alipay"] });
});
