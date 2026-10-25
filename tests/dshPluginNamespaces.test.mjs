import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isDshPluginNamespace, dshPluginNamespaceTitleKey, KNOWN_PLUGIN_NAMESPACE_TITLES } = loadTsCommonJs("src/renderer/src/config/dshPluginNamespaces.ts");

test("isDshPluginNamespace：已知插件命名空间属于插件区", () => {
	assert.equal(isDshPluginNamespace("agent-loop"), true);
	assert.equal(isDshPluginNamespace("shell"), true);
	assert.equal(isDshPluginNamespace("web-search-deepseek"), true);
});

test("isDshPluginNamespace：host 未来新注册的插件命名空间自动进入插件区（不硬编码）", () => {
	assert.equal(isDshPluginNamespace("mcp-client"), true);
	assert.equal(isDshPluginNamespace("compaction"), true);
});

test("isDshPluginNamespace：PiDeck 独占管理的保留命名空间不属于插件区", () => {
	assert.equal(isDshPluginNamespace("llm-deepseek"), false);
	assert.equal(isDshPluginNamespace("llm-pi-ai"), false);
	assert.equal(isDshPluginNamespace("permission"), false);
	assert.equal(isDshPluginNamespace("agent-preset-registry"), false);
});

test("dshPluginNamespaceTitleKey：已知插件返回 i18n 标题 key", () => {
	assert.equal(dshPluginNamespaceTitleKey("agent-loop"), "config.dsh.pluginAgentLoop");
	assert.equal(dshPluginNamespaceTitleKey("shell"), "config.dsh.pluginShell");
	assert.equal(dshPluginNamespaceTitleKey("web-search-deepseek"), "config.dsh.pluginWebSearch");
});

test("dshPluginNamespaceTitleKey：未知插件返回 undefined（UI 回退显示 ns 原名）", () => {
	assert.equal(dshPluginNamespaceTitleKey("mcp-client"), undefined);
});

test("KNOWN_PLUGIN_NAMESPACE_TITLES：所有已收录 key 都存在于 i18n 字典", () => {
	// 从 i18n 桶取 zh-CN 字典，验证标题 key 不是悬空引用
	const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	for (const key of Object.values(KNOWN_PLUGIN_NAMESPACE_TITLES)) {
		assert.ok(key in zhCN, `标题 key 缺失: ${key}`);
	}
});
