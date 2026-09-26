// 配置守卫：build.nsis 不得包含 allowDowngrade。
// 反向守卫原因（2026-09-25 channel-switch PoC 结论）：electron-builder 26.x（app-builder-lib
// scheme.json 的 NsisOptions additionalProperties:false）没有 allowDowngrade 这个配置项，
// 误加会在打包时被 @develar/schema-utils 校验直接抛
// "configuration.nsis has an unknown property 'allowDowngrade'"（InvalidConfigurationError），
// 所有 electron-builder 构建全部失败。
// dev→stable 降级覆盖安装不需要任何配置：NSIS 模板 uninstallOldVersion
// （app-builder-lib/templates/nsis/include/installUtil.nsh）只读注册表后无条件执行旧版卸载器，
// 没有版本比较逻辑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("build.nsis 不得包含 allowDowngrade（electron-builder 26.x 无此键，误加即炸构建）", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(!("allowDowngrade" in (pkg.build?.nsis ?? {})), "build.nsis.allowDowngrade 不是 electron-builder 26.x 的合法配置项；降级安装由 NSIS 模板无条件卸载旧版天然支持");
});
