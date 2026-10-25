/**
 * 未信任项目错误识别的契约（P1-2 回归）。
 *
 * 历史缺陷（2026-10-04 实测）：项目资源管理器在未信任项目上把裸 IPC 异常
 * 「Error invoking remote method 'pi-resources:summary': Error: Project is not trusted.」
 * 原样显示给用户。主进程拒读是正确门禁；渲染层必须识别这类错误并换成引导文案。
 * 注意 Electron 会给抛出的错误加 invoke 前缀，且两条主进程链路文案不同（中英各一）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isProjectUntrustedError } = loadTsCommonJs("src/renderer/src/config/projectResourceErrors.ts");

test("识别两条主进程链路的未信任错误（含 Electron invoke 前缀）", () => {
	assert.equal(isProjectUntrustedError(new Error("Project is not trusted.")), true);
	assert.equal(isProjectUntrustedError(new Error("Error invoking remote method 'pi-resources:summary': Error: Project is not trusted.")), true);
	assert.equal(isProjectUntrustedError(new Error("Error invoking remote method 'config:get-mcp': 请先信任项目，再安装项目级资源。")), true);
});

test("其它错误不误判", () => {
	assert.equal(isProjectUntrustedError(new Error("settings.json changed on disk; reload before saving.")), false);
	assert.equal(isProjectUntrustedError(new Error("Project not found.")), false);
	assert.equal(isProjectUntrustedError(undefined), false);
	assert.equal(isProjectUntrustedError(""), false);
});

test("未信任引导文案双语齐全，且两个错误面都接入识别器", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.ok(zh.includes('"config.projectUntrusted.notice"'), "zh-CN 缺少未信任引导文案");
	assert.ok(en.includes('"config.projectUntrusted.notice"'), "en-US 缺少未信任引导文案");

	for (const file of ["src/renderer/src/config/PiBuiltinExtensionsPanel.tsx", "src/renderer/src/config/McpTab.tsx"]) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /import \{ isProjectUntrustedError \} from "\.\/projectResourceErrors";/, `${file} 未接入识别器`);
		assert.match(source, /isProjectUntrustedError\(caught\) \? t\("config\.projectUntrusted\.notice"\)/, `${file} 未把未信任错误映射为引导文案`);
	}
});
