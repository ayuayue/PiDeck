/**
 * 全局用量自动查询开关已删除的契约测试。
 *
 * 背景：原「设置 → 通用 → 自动查询供应商用量」是全局闸门，默认关且关着时卡片上
 * 连入口都不渲染，用户找不到地方开。现在改成每个 provider 徽章里的开关（写
 * usage-probes.json 的 enabled，默认关），弹窗里的「是否启用」是同一字段的另一个入口。
 *
 * 这里锁三件事：
 *  1. 设置类型/Store/UI/i18n 不再有全局开关（否则旧 UI 会继续读一个没人写的字段）；
 *  2. Store 启动时把旧字段从磁盘清掉（整体持久化会让它永远留在文件里）；
 *  3. 自动查询门控只认 provider 级开关，不再读 settings。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("设置契约里不再有 providerUsageAutoQueryEnabled", () => {
	const settingsType = read("src/shared/types/settings.ts");
	assert.doesNotMatch(settingsType, /providerUsageAutoQueryEnabled/);

	const store = read("src/main/settings/SettingsStore.ts");
	assert.doesNotMatch(store, /providerUsageAutoQueryEnabled:\s*false/);

	const commonTab = read("src/renderer/src/components/app/settings/CommonTab.tsx");
	assert.doesNotMatch(commonTab, /providerUsageAutoQuery/);

	const summary = read("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
	assert.doesNotMatch(summary, /providerUsageAutoQuery/);

	const app = read("src/renderer/src/App.tsx");
	assert.doesNotMatch(app, /providerUsageAutoQuery/);

	const preview = read("src/renderer/src/previewApi.ts");
	assert.doesNotMatch(preview, /providerUsageAutoQuery/);

	const atoms = read("src/renderer/src/atoms/provider-usage-atoms.ts");
	assert.doesNotMatch(atoms, /providerUsageAutoQueryEnabledAtom/);

	// i18n 两套文案同步删除（残留 key 会让人以为开关还在）。
	for (const locale of [
		"src/renderer/src/i18n/rendererCopy.zh-CN.ts",
		"src/renderer/src/i18n/rendererCopy.en-US.ts",
	]) {
		assert.doesNotMatch(read(locale), /settings\.providerUsageAutoQuery/);
	}
});

test("SettingsStore 启动时清理旧字段并落盘一次（否则永远写回磁盘）", () => {
	const store = read("src/main/settings/SettingsStore.ts");
	assert.match(store, /this\.migrateRemovedUsageAutoQuerySwitch\(\)/);
	assert.match(store, /private migrateRemovedUsageAutoQuerySwitch\(\)/);
	// 用 unknown 收窄后 delete，再立即 save（磁盘 JSON 无类型）。
	assert.match(store, /const legacy = this\.settings as unknown as Record<string, unknown>;/);
	assert.match(store, /delete legacy\.providerUsageAutoQueryEnabled;/);
	assert.match(store, /void this\.save\(\)\.catch\(\(\) => undefined\)/);
});

test("自动查询门控只认 provider 级开关（不再读 settings）", () => {
	const hook = read("src/renderer/src/hooks/useProviderUsage.ts");
	// 开关来自状态表（usage-probes.json 的 enabled），而不是任何全局设置。
	assert.match(hook, /const queryEnabled = state\?\.enabled === true;/);
	assert.match(hook, /if \(!provider \|\| !cacheKey \|\| !queryEnabled\) return;/);
	assert.doesNotMatch(hook, /useAtomValue\(providerUsageAutoQueryEnabledAtom\)/);

	// 纯策略层不再接受全局开关字段。
	const strategy = read("src/renderer/src/hooks/providerUsageAutoQuery.ts");
	assert.doesNotMatch(strategy, /autoQueryEnabled/);
});

test("启动预热只查已开启的 provider，且串行错峰", () => {
	const warmup = read("src/renderer/src/hooks/providerUsageWarmup.ts");
	assert.match(warmup, /if \(!state\?\.enabled\) continue;/);
	assert.match(warmup, /PROVIDER_USAGE_WARMUP_GAP_MS = 300/);

	const hook = read("src/renderer/src/hooks/useProviderUsage.ts");
	assert.match(hook, /export function useProviderUsageStartupWarmup\(\): void/);
	// 装配层调用一次（App.tsx），不在子组件里重复挂。
	const app = read("src/renderer/src/App.tsx");
	assert.match(app, /useProviderUsageStartupWarmup\(\);/);
});

test("开关只存在「用量查询」弹窗里（徽章只读）", () => {
	// 徽章不挂开关：未启用时直接不渲染（不留「未启用」文案），开关在弹窗里。
	const inline = read("src/renderer/src/components/app/ProviderUsageInline.tsx");
	assert.doesNotMatch(inline, /useSetProviderUsageEnabled/);
	assert.doesNotMatch(inline, /provider-usage-toggle/);
	assert.doesNotMatch(inline, /from "\.\.\/ui-shadcn\/switch"/);
	assert.match(inline, /if \(!state\?\.enabled\) return null;/);
	assert.doesNotMatch(inline, /config\.usage\.badgeOff/);
	// 弹窗保留「是否启用」开关，默认关（用户显式开启才真正查询）。
	const dialog = read("src/renderer/src/config/UsageProbeConfigDialog.tsx");
	assert.match(dialog, /data-testid="usage-probe-enable"/);
	assert.match(dialog, /setEnabled\(config\?\.enabled \?\? false\)/);
	// 主进程按同一个字段判定生效开关（enabled ?? false）。
	const manager = read("src/main/config/ConfigManager.ts");
	assert.match(manager, /enabled: config\?\.enabled \?\? false/);
	assert.match(manager, /if \(settings\.config\?\.enabled !== true\) \{/);
});
