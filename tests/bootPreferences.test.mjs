import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归（2026-10 流畅度审计）：index.ts 模块顶层的沙箱/单实例/宠物三个启动偏好
// 曾各自 readFileSync+JSON.parse 同一份 settings.json，现在经 readBootPreferences
// 一次读取共享快照；启动后调用方（PetWindow/EnvironmentDoctor）仍走各 helper 的
// 独立读取（默认参数兜底），实时语义不变。
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");

test("boot preferences share one settings snapshot instead of three reads", () => {
	assert.match(settingsStore, /export function readBootPreferences\(\) \{/, "readBootPreferences 应存在");
	for (const name of ["readElectronChromiumSandboxPreference", "readSingleInstancePreference", "readPetEnabledPreference"]) {
		// helper 必须接受可选共享快照，且默认值兜底仍指向独立读取（启动后调用方语义不变）
		assert.match(settingsStore, new RegExp(`export function ${name}\\(settings: Partial<AppSettings> = readDesktopSettingsSync\\(\\)\\): boolean`), `${name} 应接受可选共享快照`);
	}
	// index.ts 不得再直接调用三个独立 helper（否则合并读取被旁路）
	assert.doesNotMatch(mainIndex, /readElectronChromiumSandboxPreference\(\)|readSingleInstancePreference\(\)|readPetEnabledPreference\(\)/);
	assert.match(mainIndex, /const bootPreferences = readBootPreferences\(\)/);
	// 共享快照必须在 userData setPath 之后读取：dev 模式下 settings.json 位置已被覆盖，
	// 读早了会误读正式版 settings（宠物开关/Linux 显示后端决策依赖这一点）。
	const setPathIdx = mainIndex.indexOf("app.setPath(");
	const snapshotIdx = mainIndex.indexOf("const bootPreferences = readBootPreferences()");
	assert.ok(setPathIdx === -1 || snapshotIdx > setPathIdx, "bootPreferences 必须在 userData setPath 之后读取");
});

test("cold start milestones are logged at app ready and first window shown", () => {
	// 回归（2026-10 流畅度审计）：全仓此前无任何冷启动计时埋点，启动优化无法度量回归。
	// 两个里程碑挂点：whenReady 内 appLogger 创建之后、showMainWindowOnce（ready-to-show /
	// did-finish-load / 3s 兜底三路共用）。
	assert.match(mainIndex, /const bootAnchorMs = Date\.now\(\)/);
	assert.match(mainIndex, /Cold start milestone: app ready/);
	assert.match(mainIndex, /Cold start milestone: first window shown/);
});

test("first session list records scan cost as the third cold start milestone", () => {
	// 前两个里程碑只到「窗口可见」，用户真正看到内容要等首个 sessions:list 返回。
	// scanMs 必须单独记录：否则无法区分「窗口起得慢」和「会话扫描慢」（侧栏扫描是
	// 唯一还没进 sidecar 的机械成本，Wave 3 的收益门禁就靠这个数字）。
	assert.match(sessionIpc, /Cold start milestone: first session list/);
	assert.match(sessionIpc, /scanMs:\s*Date\.now\(\) - startedAt/);
	assert.match(sessionIpc, /processUptimeMs:\s*Math\.round\(process\.uptime\(\) \* 1000\)/);
	// 只记一次：切项目会重复调用 sessions:list，重复记录会淹没真正的冷启动数据。
	assert.match(sessionIpc, /let firstSessionListMilestoneLogged = false/);
	assert.match(sessionIpc, /if \(!firstSessionListMilestoneLogged\)/);
});
