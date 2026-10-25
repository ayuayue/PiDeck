import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * issue #253 的收尾：DSH 模型偏好被 host 拒绝时必须让用户看得见。
 *
 * 背景：引导页 DSH 点选已接通（createDraft 接受显式 model → 激活时
 * applyPreferences → DshAgentManager.setModel → host sessions.selectModel）。
 * 但 DSH 的失败路径此前**只有 logger.warn**：host 拒绝（模型不在 host 目录 /
 * 档位不被支持 / busy）时，Coordinator 保留 catalog 偏好并降级到部署默认，
 * 用户界面完全没有痕迹——底栏显示自己选的模型，实际跑的是部署默认。
 *
 * 这比修复前的「选不动」更难排查：修复前点选被丢弃，底栏和运行时一致地显示
 * 部署默认；修好点选却不补提示，就变成「显示了但不生效」的静默不一致。
 *
 * 通道选择（有事实依据）：不能用会话内系统消息，因为 DSH 的 runtime.messages
 * 是 host projection 的整段替换（DshAgentManager 里 5 处 `runtime.messages =
 * projection.messages`），本地注入的消息下一次投影就被冲掉。因此走
 * ipcChannels.agentsNotice（渲染层 useSessionRuntimeBridge → showNotice）。
 */

const dshManager = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
const bridge = readFileSync("src/renderer/src/hooks/useSessionRuntimeBridge.ts", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("DSH 实现 notifyModelPreferenceIgnored（模型偏好落不下去时提示用户）", () => {
	assert.match(dshManager, /notifyModelPreferenceIgnored\s*\(/, "DSH 未实现该 gateway 可选方法 → host 拒绝时只会写日志，用户看不到任何提示");
});

test("DSH 的提示走 agentsNotice（而不是会话内消息）", () => {
	// 会话内消息会被 projection 整段替换冲掉（5 处 runtime.messages = projection.messages），
	// 因此提示必须走 toast 通道。
	assert.match(dshManager, /ipcChannels\.agentsNotice/, "DSH 未使用 agentsNotice：本地注入的消息会被 host projection 覆盖");
	const notifyBlock = dshManager.slice(dshManager.indexOf("notifyModelPreferenceIgnored"));
	assert.match(notifyBlock.slice(0, 900), /ipcChannels\.agentsNotice/);
	assert.match(notifyBlock.slice(0, 900), /agentId/);
});

test("提示文案在渲染层字典中可用（toast 用 t() 解析，主进程字典不适用）", () => {
	const key = "notice.modelPreferenceIgnored";
	assert.match(zhCopy, new RegExp(`"${key.replace(".", "\\.")}"`), `渲染层中文缺 ${key}：toast 的 t() 找不到键会原样显示 key`);
	assert.match(enCopy, new RegExp(`"${key.replace(".", "\\.")}"`), `渲染层英文缺 ${key}`);
	// agentsNotice 通道的 t() 不支持占位符（与 app.abortSlow 等既有 key 同约定）：
	// key 必须是无占位符的完整句子，模型身份由调用方走 message 字段兜底。
	assert.doesNotMatch(zhCopy, new RegExp(`"${key.replace(".", "\\.")}"[^\\n]*\\{`));
});

test("Coordinator 对 DSH 的降级路径调用该提示（pi 与 DSH 同语义）", () => {
	// 现有代码：modelGoneOnPi 才 notify，DSH 只写日志。两者都该通知用户。
	assert.match(coordinator, /notifyModelPreferenceIgnored\?\.\(agentId/, "Coordinator 未调用提示回调");
	const applyBlock = coordinator.slice(coordinator.indexOf("private async applyPreferences("), coordinator.indexOf("private isModelGoneError("));
	assert.match(applyBlock, /DSH model preference ignored/, "找不到 DSH 降级分支（测试锚点失效，请更新）");
	// DSH 分支也必须走到 notify（不能只在 modelGoneOnPi 时调）
	const dshLogIndex = applyBlock.indexOf("DSH model preference ignored");
	const notifyAfterDshLog = applyBlock.slice(dshLogIndex);
	assert.match(notifyAfterDshLog, /notifyModelPreferenceIgnored\?\.\(agentId/, "DSH 降级后没有告知用户（静默失败）");
});

test("toast 通道确实把 agents:notice 渲染成提示（契约锚点）", () => {
	assert.match(bridge, /event\.sourceChannel === "agents:notice"/);
	assert.match(bridge, /showNotice\(/);
});
