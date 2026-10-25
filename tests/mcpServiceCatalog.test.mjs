import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MCP_SERVICE_CATALOG, buildCatalogDefinition, catalogNeedsCredential } = loadTsCommonJs("src/renderer/src/config/mcpServiceCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const byId = Object.fromEntries(MCP_SERVICE_CATALOG.map((entry) => [entry.id, entry]));

test("MCP service catalog ships the verified batches (intl + CN) with categories and unique ids", () => {
	const ids = Array.from(MCP_SERVICE_CATALOG, (entry) => entry.id);
	assert.deepEqual(ids, ["pideck", "context7", "modelscope", "playwright", "chrome-devtools", "github", "sentry", "supabase", "linear", "notion", "lark", "dingtalk", "alipay", "tencent-docs", "baidu-netdisk", "amap", "tencent-map", "rail12306", "baizhi", "brave-search", "firecrawl", "exa", "tavily", "figma", "qcc"]);
	assert.equal(new Set(ids).size, ids.length);
	for (const entry of MCP_SERVICE_CATALOG) {
		assert.ok(["dev", "work", "data", "maps", "search", "design"].includes(entry.category), `${entry.id} category`);
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
	// Tavily：官方远程地址只接受 URL query 里的 tavilyApiKey，必填。
	assert.equal(byId.tavily.auth, "url-key");
	assert.equal(catalogNeedsCredential(byId.tavily), true);
	assert.deepEqual(plain(byId.tavily.credentials[0].credential), { kind: "url-query", param: "tavilyApiKey" });
	// 裸 token 头（官方要求原值，不能加 Bearer）：腾讯文档必填、Exa 可留空（keyless 限速）。
	assert.deepEqual(plain(byId["tencent-docs"].credentials[0].credential), { kind: "header", header: "Authorization" });
	assert.equal(catalogNeedsCredential(byId["tencent-docs"]), true);
	assert.deepEqual(plain(byId.exa.credentials[0].credential), { kind: "header", header: "x-api-key" });
	assert.equal(byId.exa.credentials[0].optional, true);
	assert.equal(catalogNeedsCredential(byId.exa), false);
	// 企查查：Bearer 头必填；百度网盘：Access Token 走环境变量，供本地桥接进程使用。
	assert.deepEqual(plain(byId.qcc.credentials[0].credential), { kind: "header", header: "Authorization", scheme: "Bearer" });
	assert.equal(catalogNeedsCredential(byId.qcc), true);
	assert.equal(byId.qcc.category, "data");
	assert.deepEqual(plain(byId["baidu-netdisk"].credentials[0].credential), { kind: "env", envKey: "BAIDU_NETDISK_ACCESS_TOKEN" });
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
	// Tavily：key 拼进 URL query（base 末尾已带 / 仍只加一个 ?）。
	assert.deepEqual(plain(buildCatalogDefinition(byId.tavily, ["tvly-abc"])), { url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-abc" });
	// 腾讯文档：声明里没有 scheme，Authorization 头必须写原值（加 Bearer 会被拒）。
	assert.deepEqual(plain(buildCatalogDefinition(byId["tencent-docs"], ["docs-token"])), { url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: "docs-token" } });
	// Exa：x-api-key 原值；留空回到 keyless 定义。
	assert.deepEqual(plain(buildCatalogDefinition(byId.exa, ["exa-key"])), { url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "exa-key" } });
	assert.deepEqual(plain(buildCatalogDefinition(byId.exa, [""])), { url: "https://mcp.exa.ai/mcp" });
	// 企查查：Bearer 头。
	assert.deepEqual(plain(buildCatalogDefinition(byId.qcc, ["qcc-key"])), { url: "https://agent.qcc.com/mcp/company/stream", headers: { Authorization: "Bearer qcc-key" } });
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
	// simple-icons 未收录的服务回退 lucide（官方未收录则不硬造 logo）；钉钉/飞书用 ant-design / 飞书官方 CDN 图形。
	const fallbacks = [...ids].filter((id) => !branded.has(id)).sort();
	assert.deepEqual(fallbacks, ["amap", "context7", "firecrawl", "rail12306", "tencent-map"]);
	// 新增条目必须带官方图形：tavily/exa 用官方 SVG（各自声明原始画板），
	// 腾讯文档/企查查/百度网盘官方只发位图 → 内联官方 app 图标（data URI）；
	// piDeck 的 π 标归一到 24 网格，与其它品牌图标同为 14px 满格。
	assert.equal(MCP_BRAND_ICONS.pideck.viewBox, undefined);
	assert.equal(MCP_BRAND_ICONS.pideck.path, "M0 0H18V12H12V18H6V24H0ZM6 6V12H12V6ZM18 12H24V24H18Z");
	assert.equal(MCP_BRAND_ICONS.tavily.viewBox, "0 0 55 55");
	assert.equal(MCP_BRAND_ICONS.exa.viewBox, "0 0 256 256");
	for (const id of ["tencent-docs", "baidu-netdisk", "qcc", "baizhi"]) {
		assert.match(MCP_BRAND_ICONS[id].png ?? "", /^data:image\/png;base64,[A-Za-z0-9+/=]+$/, `${id} inline png`);
		assert.equal(MCP_BRAND_ICONS[id].path, undefined, `${id} keeps no vector path`);
		assert.equal(MCP_BRAND_ICONS[id].multiPaths, undefined, `${id} keeps no multiPaths`);
	}
	// 百智云的黑色圆环位图必须带浅色底片，否则暗色主题下描边被背景吞掉、只剩一个白圆盘（见 plate 契约）。
	assert.equal(MCP_BRAND_ICONS.baizhi.plate, "#FDFDFD");
	for (const [id, icon] of Object.entries(MCP_BRAND_ICONS)) {
		assert.match(icon.hex, /^#[0-9A-Fa-f]{6}$/, `${id} hex`);
		if (icon.plate) {
			assert.match(icon.plate, /^#[0-9A-Fa-f]{6}$/, `${id} plate`);
		}
		if (icon.png) {
			// 官方位图：data URI 内联（离线可用，不新增远程依赖）
			assert.match(icon.png, /^data:image\/png;base64,/, `${id} png`);
		} else if (icon.multiPaths) {
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
		if (icon.viewBox !== undefined) assert.match(icon.viewBox, /^0 0 \d+(\.\d+)? \d+(\.\d+)?$/, `${id} viewBox`);
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
	// 百度网盘官方远程端点只有 SSE（pi 只支持 streamable HTTP）：经 mcp-remote 桥接，
	// 桥接进程 http-first、405 回退 SSE，Authorization 头引用环境变量里的 Access Token。
	assert.deepEqual(plain(byId["baidu-netdisk"].base), { command: "npx", args: ["-y", "mcp-remote@latest", "https://mcp-pan.baidu.com/sse", "--header", "Authorization: Bearer ${BAIDU_NETDISK_ACCESS_TOKEN}"] });
});

test("Baizhi requires a raw API key and binds it only to the fixed endpoint Authorization header", () => {
	const entry = byId.baizhi;
	assert.equal(entry.category, "search");
	assert.equal(entry.auth, "header-key");
	assert.equal(catalogNeedsCredential(entry), true);
	assert.deepEqual(plain(entry.credentials), [{ labelKey: "config.mcp.catalog.baizhiKey", credential: { kind: "header", header: "Authorization", scheme: "Bearer" } }]);
	const baseBefore = plain(entry.base);
	const first = plain(buildCatalogDefinition(entry, ["  synthetic-baizhi-a  "]));
	const second = plain(buildCatalogDefinition(entry, ["synthetic-baizhi-b"]));
	assert.deepEqual(first, { url: "https://agent-toolkit.app.baizhi.cloud/mcp", headers: { Authorization: "Bearer synthetic-baizhi-a" } });
	assert.deepEqual(second, { url: "https://agent-toolkit.app.baizhi.cloud/mcp", headers: { Authorization: "Bearer synthetic-baizhi-b" } });
	assert.deepEqual(plain(entry.base), baseBefore, "a second template must not reuse another credential");
	assert.deepEqual(plain(buildCatalogDefinition(entry, [" "])), baseBefore, "the builder leaves blank credentials out; the required form field blocks connection");
});

test("Figma registers under an allow-listed DCR client name; other OAuth entries keep pi's default", () => {
	const { MCP_DCR_CLIENT_NAME_OVERRIDES, buildCatalogBase } = loadTsCommonJs("src/renderer/src/config/mcpServiceCatalog.ts");
	// 只登记实测被授权服务器白名单挡掉的服务（Figma 对 client_name 做校验，pi 403 / Claude Code 200）。
	assert.deepEqual(plain(MCP_DCR_CLIENT_NAME_OVERRIDES), { figma: "Claude Code" });
	assert.deepEqual(plain(buildCatalogBase(byId.figma)), { url: "https://mcp.figma.com/mcp", oauth: { clientName: "Claude Code" } });
	// 覆盖值必须同时出现在模板保存与目录定义两条路径上，否则「从模板建」和「从代码建」行为不一致。
	assert.deepEqual(plain(buildCatalogDefinition(byId.figma, [])), plain(buildCatalogBase(byId.figma)));
	// 未登记的 OAuth 服务（实测 pi 动态注册均放行）不得被顺手加上 clientName。
	for (const id of ["sentry", "supabase", "linear", "notion"]) {
		assert.deepEqual(plain(buildCatalogBase(byId[id])), plain(byId[id].base), id);
		assert.equal(Object.hasOwn(buildCatalogBase(byId[id]), "oauth"), false, id);
	}
	// 覆盖值不得泄露到条目的静态字段上（表单不展示，避免无意义文案）；只走 buildCatalogBase 注入。
	assert.equal(Object.hasOwn(byId.figma, "authNoticeKey"), false);
	assert.equal(Object.hasOwn(byId.figma.base, "oauth"), false);
});
