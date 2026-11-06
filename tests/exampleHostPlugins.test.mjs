import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readHostPluginPackage, readPluginFile } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");

/**
 * 示例宿主插件（`docs/examples/host-plugins/<id>/`）的出厂契约。
 *
 * 这些包不随 PiDeck 分发（安装来源只有「从文件夹安装…」/ 市场/文件），但它们是文档里点名的参考实现：
 * manifest 写错、面板入口指向不存在的资产、能力面偷偷扩大，用户照文档装上去只会看到坏样本。
 * 这里把「能过安装校验、能力面经审阅」钉成测试。
 */
const EXAMPLE_DIRECTORY = join(process.cwd(), "docs", "examples", "host-plugins");

/**
 * 示例包的已审能力面登记表：权限/服务/面板形态变化必须先审一遍数据外发与命令执行风险，再改这里。
 * 测试要求目录与登记表一一对应，避免「悄悄多了一个示例」或漏改已变更的能力面。
 */
const EXAMPLE_PLUGINS = {
	"billion-context": { permissions: ["service.local"], services: ["billion-context"], panelId: "main", presentation: "popover", icon: "activity" },
	"example.network": { permissions: ["network.https", "network.local"], panelId: "main", presentation: "page", icon: "globe" },
	"session-groups": { permissions: ["sessions.read", "sessions.read.workspace", "workbench.navigate", "sessionGroups.manage"], panelId: "main", presentation: "page", icon: "layers" },
};

/** 面板 HTML 引用的包内资产（`src`/`href`），外链与锚点单独判定，不当作包内路径。 */
function referencedAssets(html) {
	return [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

test("示例插件目录与登记表一一对应，每个包都能过安装校验", async () => {
	const entries = (await readdir(EXAMPLE_DIRECTORY, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
	assert.deepEqual(entries.sort(), Object.keys(EXAMPLE_PLUGINS).sort(), "新增/删除示例插件必须同步本文件的登记表");
	for (const name of entries) {
		const plugin = await readHostPluginPackage(join(EXAMPLE_DIRECTORY, name));
		// 安装按目录名与 manifest.id 对齐（「从文件夹安装…」选的就是这一层），不一致会让授权记录落到另一个 id 上。
		assert.equal(plugin.manifest.id, name, `${name}: manifest.id 必须等于目录名`);
		assert.equal(plugin.manifest.apiVersion, 1);
		// manifest 自带 `pideck-plugin.json` 在资产表里，但宿主永不服务它（asset-not-allowed）；这里确认它没被漏进指纹。
		assert.ok(plugin.assets.has("pideck-plugin.json"));
	}
});

test("示例插件的面板入口只引用包内资产，不挂外链", async () => {
	for (const name of Object.keys(EXAMPLE_PLUGINS)) {
		const plugin = await readHostPluginPackage(join(EXAMPLE_DIRECTORY, name));
		const base = plugin.root;
		for (const panel of plugin.manifest.contributes.panels) {
			const html = (await readPluginFile(base, panel.entry)).toString("utf8");
			const directory = panel.entry.includes("/") ? panel.entry.slice(0, panel.entry.lastIndexOf("/") + 1) : "";
			for (const reference of referencedAssets(html)) {
				assert.equal(/^https?:\/\//i.test(reference), false, `${name}: 面板不能引用外链（CSP default-src 'none' 会直接拦掉）：${reference}`);
				if (reference.startsWith("#") || reference.startsWith("data:")) continue;
				const asset = join(directory, reference.replace(/^\.\//, ""));
				assert.ok(plugin.assets.has(asset), `${name}: 面板引用了没有随包的资产 ${asset}（漏复制 / 改名 / 大小写不一致）`);
			}
		}
	}
});

test("session-groups：能力面锁定在只读会话 + 工作区范围 + 工作台跳转 + 分组读写", async () => {
	const plugin = await readHostPluginPackage(join(EXAMPLE_DIRECTORY, "session-groups"));
	const expected = EXAMPLE_PLUGINS["session-groups"];
	assert.deepEqual(Array.from(plugin.manifest.permissions), expected.permissions);
	// 分组数据走宿主 store（sessionGroups.*），因此它不该有任何网络/服务能力。
	assert.equal(plugin.manifest.network, undefined);
	assert.equal(plugin.manifest.services, undefined);
	assert.deepEqual(
		Array.from(plugin.manifest.contributes.panels, (panel) => ({ id: panel.id, entry: panel.entry, icon: panel.icon, presentation: panel.presentation })),
		[{ id: expected.panelId, entry: "app.html", icon: expected.icon, presentation: expected.presentation }],
	);
	// 侧栏入口靠已启用插件的面板声明；命令表可以为空，但不能指向不存在的面板。
	assert.deepEqual(Array.from(plugin.manifest.contributes.commands), []);
});
