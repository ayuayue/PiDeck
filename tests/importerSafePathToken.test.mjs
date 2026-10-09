import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// safePathToken 生成 pi 会话目录名，必须产出各平台合法目录名。
// 回归点：盘符根项目（D:\）以前落到 fallback 分支产出 "--D:---"——Windows 目录名
// 不允许 ":"，mkdir 直接 EINVAL，该项目的会话导入必败（2026-03 审计实测）。
const importers = [
	["ClaudeSessionImporter", "src/main/sessions/ClaudeSessionImporter.ts"],
	["CodexSessionImporter", "src/main/sessions/CodexSessionImporter.ts"],
	["OpenCodeSessionImporter", "src/main/sessions/OpenCodeSessionImporter.ts"],
	["ZCodeSessionImporter", "src/main/sessions/ZCodeSessionImporter.ts"],
];

const WIN_DRIVE_ROOT = "D:" + "\\";
const NORMAL_WIN = "D:" + "\\" + "proj";
const DEEP_WIN = "C:" + "\\" + "a" + "\\" + "b" + "\\" + "c";

for (const [name, path] of importers) {
	test(`safePathToken（${name}）：盘符根不产出含 ":" 的非法目录名，普通路径 token 不变`, async () => {
		const mod = await loadTsCommonJs(path, { stubs: { electron: { app: { getPath: () => "C:\\tmp" } } } });
		const importer = new mod[name]();
		const token = (p) => importer.safePathToken(p);
		// 盘符根：修复前 "--D:---"（EINVAL）；修复后无冒号。只断言真实输入形态——
		// 规范化绝对路径必带斜杠，裸 "D:" 不会出现在 projectPath 里，不为不可达输入改共享 fallback
		const driveRootToken = token(WIN_DRIVE_ROOT);
		assert.ok(!driveRootToken.includes(":"), `${WIN_DRIVE_ROOT} 产出 ${driveRootToken}`);
		// 普通路径不受影响（已有导入目录的兼容锚点，格式绝不能变）
		assert.equal(token(NORMAL_WIN), "--D--proj--");
		assert.equal(token(DEEP_WIN), "--C--a-b-c--");
	});
}
