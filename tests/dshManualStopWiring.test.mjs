/**
 * DSH host 手动停止（dshManualStopped）接线测试。
 *
 * 背景：部分用户不想让 DSH host（共享 utilityProcess，~200MB）运行。手动停止后
 * 必须 **只有用户显式启动** 才能再运行——所有自动拉起路径都要被门控。
 * 本测试验证各层接线齐全（单层行为已由 dshManualStop.test.mjs 覆盖）：
 * - 设置类型 + 持久化默认值（false = 保持按需自动启动的历史语义）；
 * - 主进程所有自动路径（预热 / 按需兜底 / IPC 门控）都读取标记；
 * - IPC 三处同步（通道常量 / sessionIpc handler / preload 暴露）；
 * - i18n 中英文案齐全。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const dshHost = readFileSync("src/main/dsh/DshHost.ts", "utf8");
const dshHostProcess = readFileSync("src/main/dsh/DshHostProcess.ts", "utf8");
const ipcChannels = readFileSync("src/shared/ipc.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const sessionTypes = readFileSync("src/shared/types/session.ts", "utf8");
const dshManualStop = readFileSync("src/main/dsh/dshManualStop.ts", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const timelineController = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
const appShell = readFileSync("src/renderer/src/App.tsx", "utf8");
const historyMutations = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");
const trajectorySource = readFileSync("src/renderer/src/hooks/useSessionTrajectorySource.ts", "utf8");
const availabilityUtil = readFileSync("src/renderer/src/utils/sessionHistoryAvailability.ts", "utf8");
/** 所有直接消费 readRecordMessagePage 返回页的渲染层模块（新生效点也必须进这道闸）。 */
const pageConsumers = [
	["useSessionTimelineController", timelineController],
	["App", appShell],
	["useSessionHistoryMutations", historyMutations],
	["useSessionTrajectorySource", trajectorySource],
];

test("dshManualStopped: 类型定义存在且默认 false（保持自动启动语义）", () => {
	assert.match(settingsType, /dshManualStopped\?: boolean/);
	assert.match(store, /dshManualStopped: false/);
});

test("dshManualStopped: 旧 JSON 脏值回落 false（字符串/数字不能把 host 永久锁死）", () => {
	// 加载清洗 + 更新入口双向校验：读路径回落 + 写路径拒绝非布尔
	assert.match(store, /typeof this\.settings\.dshManualStopped !== "boolean"[\s\S]{0,120}dshManualStopped = false/);
	assert.match(store, /"dshManualStopped" in safePatch && typeof safePatch\.dshManualStopped !== "boolean"[\s\S]{0,80}delete safePatch\.dshManualStopped/);
});

test("dshManualStopped: 主进程自动拉起路径全部读标记", () => {
	// 后台预热（含自动更新完成后补预热）统一走 dshWarmupEnabled 门控
	assert.match(mainIndex, /dshWarmupEnabled\(\): boolean/);
	assert.match(mainIndex, /dshManualStopped !== true/);
	// runtime 磁盘操作后的 host 恢复也必须跳过手动停止态
	assert.match(mainIndex, /startDshHostAfterRuntimeDiskOperation/);
	// DshHost / DshHostProcess 构造注入标记 getter
	assert.match(mainIndex, /settingsStore\.get\(\)\.dshManualStopped === true/);
	// 策略层：ensureStarted 门控 + 显式启动入口
	assert.match(dshHost, /isManualStopped\(\)[\s\S]{0,200}dshManuallyStoppedError/);
	assert.match(dshHost, /async startManually\(\): Promise<boolean>/);
	// 进程层：fork 前门控（崩溃自动重启路径不经 DshHost.start）
	assert.match(dshHostProcess, /if \(this\.isManualStopped\(\)\) throw dshManuallyStoppedError\(\)/);
	assert.match(dshHostProcess, /isDshManuallyStoppedError/);
});

test("dshManualStopped: IPC 三处同步（通道 / handler / preload）", () => {
	assert.match(ipcChannels, /dshStopHost: "dsh:stop-host"/);
	assert.match(ipcChannels, /dshStartHost: "dsh:start-host"/);
	assert.match(sessionIpc, /ipcChannels\.dshStopHost/);
	assert.match(sessionIpc, /ipcChannels\.dshStartHost/);
	assert.match(preload, /stopDshHost: \(\) =>[\s\S]{0,80}ipcChannels\.dshStopHost/);
	assert.match(preload, /startDshHost: \(\) =>[\s\S]{0,80}ipcChannels\.dshStartHost/);
});

test("dshManualStopped: 状态回传 manuallyStopped（渲染层显示中性徽标而非错误态）", () => {
	// getStatus 必须透出手动停止态，配置页据此区分「未启动」与「已手动停止」
	assert.match(dshHost, /manuallyStopped: this\.isManualStopped\(\)/);
	assert.match(preload, /manuallyStopped\?: boolean/);
});

test("dshManualStopped: 停止后时间线给「启动 host」专态，不说成会话文件失效", () => {
	// 2026-09 反馈：host 被手动停止后打开 DSH 会话，时间线报「会话历史加载失败 /
	// 文件可能已删除或路径失效」+ 无效重试——DSH 会话根本没有 pi 会话文件。
	// 契约链：读取异常 → main 降级成带原因的空页 → 渲染层按 reason 分流专态。
	assert.match(dshManualStop, /export function dshUnavailablePageFor/);
	assert.match(dshManualStop, /unavailable: "dsh-host-stopped"/);
	assert.match(sessionTypes, /export type SessionHistoryUnavailableReason = "dsh-host-stopped"/);
	assert.match(sessionTypes, /unavailable\?: SessionHistoryUnavailableReason/);
	// IPC 边界：读取失败先尝试降级成不可读页，不直接抛错给渲染层
	assert.match(sessionIpc, /dshUnavailablePageFor/);
	// 渲染层：只认该 reason 走专态（普通读盘失败仍走「文件可能已删除」）
	assert.match(timeline, /reason === "dsh-host-stopped"/);
	assert.match(timeline, /controller\.startDshHostAndReload\(\)/);
	// 恢复入口必须真的调 IPC 启 host：手动停止态不会自愈，只 reload 永远失败
	assert.match(timelineController, /desktopApi\.sessions\.startDshHost\(\)/);
	assert.match(timelineController, /startDshHostAndReload/);
	// 渲染层所有读页点统一过闸（判据只在 utils/sessionHistoryAvailability.ts 一处）：
	// force 写会把带原因的空页当空会话，会话看着像被清空了——用户反馈里最误导的分支。
	assert.match(availabilityUtil, /export function sessionHistoryUnavailableState/);
	assert.match(availabilityUtil, /if \(!page\.unavailable\) return null;\s*return \{ status: "error", reason: page\.unavailable \};/);
	for (const [name, source] of pageConsumers) {
		assert.match(source, /sessionHistoryUnavailableState\(page\)/, `${name} 缺少历史不可用闸门`);
		// 禁止各处自己读裸字段：新增分支时容易只判空不辨原因（本次修的就是这种漏）
		assert.doesNotMatch(source, /page\.unavailable/, `${name} 不得直接读 page.unavailable，请走 sessionHistoryUnavailableState`);
		// 每处读页都配一道闸：新加读页点忘了加闸会在这里红（本次漏的正是一处读页分支）。
		// 只数调用形式（import 语句里没有 `(`），避免统计到声明与类型引用。
		const reads = (source.match(/readRecordMessagePage\(/g) ?? []).length;
		const gates = (source.match(/sessionHistoryUnavailableState\(/g) ?? []).length;
		assert.ok(reads > 0, `${name} 没找到读页调用（统计口径要同步更新）`);
		assert.equal(gates, reads, `${name} 读页点与闸门数量不一致（${gates}/${reads}）`);
	}
	// 早退必须发生在写缓存之前（顺序反了等于没修）
	assert.match(appShell, /sessionHistoryUnavailableState\(page\)[\s\S]{0,400}?setCacheMessages\(\{/);
	assert.match(historyMutations, /sessionHistoryUnavailableState\(page\)[\s\S]{0,400}?cacheMessages\(\{/);
	// 轨迹面板翻页不能把「暂时读不了」的空页当前缀（否则 total/游标被清空、按钮消失）
	assert.match(trajectorySource, /if \(sessionHistoryUnavailableState\(page\)\) return;/);
});

test("dshManualStopped: i18n 中英文案齐全", () => {
	for (const key of [
		"config.dsh.stopHost",
		"config.dsh.startHost",
		"config.dsh.manuallyStopped",
		"config.dsh.manuallyStoppedDesc",
		"config.dsh.hostStopped",
		"config.dsh.hostStopFailed",
		"config.dsh.hostStarted",
		"config.dsh.hostStartFailed",
		"timeline.dshHostStopped",
		"timeline.dshHostStoppedHint",
		"timeline.dshHostStoppedStart",
	]) {
		assert.match(zh, new RegExp(`"${key.replace(/\./g, "\\.")}"`));
		assert.match(en, new RegExp(`"${key.replace(/\./g, "\\.")}"`));
	}
});
