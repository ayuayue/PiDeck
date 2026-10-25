import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * e2e 语系确定性守卫（2026-10 main 流水线实际红过）。
 *
 * `SettingsStore` 的 `language` 缺省是 `"system"`：同一个用例在本机 zh-CN 弹中文、
 * 在 en-US 的 CI runner 上渲染英文，按文案定位的 `getByText(/项目/)` 之类断言就会
 * 30s 超时失败——看上去像业务回归，实际是环境依赖。
 *
 * 因此两套 fixture（真实 Electron / mock pi）都必须在 seedSettings 之前钉死 zh-CN，
 * 且 seedSettings 仍能覆盖它（要测语系切换的用例靠这条）。
 */

const appFixture = readFileSync("e2e/fixtures.ts", "utf8");
const mockPiFixture = readFileSync("e2e/mock-pi-fixture.ts", "utf8");

test("app fixture 写入 settings.json 时默认钉 zh-CN，且允许 seedSettings 覆盖", () => {
	assert.match(
		appFixture,
		/JSON\.stringify\(\s*\{\s*piEnvironmentChecked:\s*true,\s*language:\s*"zh-CN",\s*\.\.\.seedSettings\s*\}\s*\)/,
		'fixtures.ts 的 settings.json 必须形如 { piEnvironmentChecked: true, language: "zh-CN", ...seedSettings }；缺 language 会让用例跟着宿主语系变，换成 ...seedSettings 在前的顺序则覆盖失效',
	);
});

test("mock pi fixture 同样钉 zh-CN，且位于 seedSettings 之前", () => {
	const seededAt = mockPiFixture.search(/language:\s*"zh-CN"/);
	const overrideAt = mockPiFixture.search(/\.\.\.\(seedSettings\s*\?\?\s*\{\}\)/);
	assert.ok(seededAt > 0, 'mock-pi-fixture.ts 缺少 language: "zh-CN" 默认值');
	assert.ok(overrideAt > 0, "mock-pi-fixture.ts 缺少 seedSettings 合并");
	assert.ok(seededAt < overrideAt, "language 必须写在 ...(seedSettings) 之前，否则用例无法覆盖语系");
});
