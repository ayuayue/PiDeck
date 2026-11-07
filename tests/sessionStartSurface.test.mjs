import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const surface = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("start surface reuses the session bottom composer, not a second input implementation", () => {
	// 统一输入：直接居中挂完整 ComposerArea（模型/思考/模式/安全级别/发送全保留），
	// 禁止再出现自制 TipTapComposer / waitRuntimeReady / sendPrompt 链路。
	assert.match(surface, /<ComposerArea/);
	assert.match(surface, /import \{ ComposerArea \} from "\.\/ComposerArea"/);
	assert.match(surface, /import \{ QueuedPromptPanel \} from "\.\/ComposerPanels"/);
	assert.match(surface, /import \{ SessionGoalStrip \} from "\.\/SessionGoalStrip"/);
	assert.match(surface, /import \{ SessionSubagentsStrip \} from "\.\/SessionSubagentsStrip"/);
	assert.match(surface, /import \{ SessionTodoStrip \} from "\.\/SessionTodoStrip"/);
	assert.match(surface, /<SessionTodoStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(surface, /<SessionSubagentsStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(surface, /<SessionGoalStrip sessionId=\{props\.sessionId\} \/>/);
	// 「修改的文件」已改为每轮末尾的 chip 行；引导页没有轮次，不再挂文件条
	assert.doesNotMatch(surface, /SessionFilesStrip/);
	assert.match(surface, /useSessionPaneServices\(\)/);
	assert.match(surface, /queuedPromptsBySession\[props\.sessionId\]/);
	assert.match(surface, /<LogoMark size=\{72\} \/>/);
	assert.doesNotMatch(surface, /TipTapComposer/);
	assert.doesNotMatch(surface, /waitRuntimeReady|sendPrompt|getComposerEnterIntent/);
});

test("start surface centers the composer", () => {
	// DeepSeek 式居中：flex 列 + 重心下移；2027-02 起两屏共用 StartSurfaceShell 骨架，
	// 布局值只在这一处定义（无项目卡天然对齐）：860px 列 / pt-[23vh] 重心 / 15.5px 输入字号。
	assert.match(surface, /pt-\[23vh\]/);
	assert.match(surface, /max-w-\[860px\]/);
	assert.match(surface, /\[--chat-content-pct-set:100%\]/);
	assert.doesNotMatch(surface, /defaultHeight=/);
	assert.match(surface, /session-start-surface/);
	// 起步提示只填草稿不直接发送；不存在一键直发残留
	assert.doesNotMatch(surface, /QUICK_ACTIONS/);
	assert.doesNotMatch(surface, /insertQuickPrompt/);
});

test("bottom composer is hidden while the start surface is showing", () => {
	// 空会话磁盘就绪后卸底部栏，避免同屏两个输入框。
	assert.match(view, /shouldMountBottomComposer/);
	assert.match(view, /sessionTimeline\.isSurfaceLoading/);
	assert.match(view, /bottomComposerVisible &&/);
	assert.doesNotMatch(view, /id="composer"/);
	assert.doesNotMatch(view, /sessionTimeline\.messages\.length > 0 && \(/);
});

test("empty active sessions render the start surface with the session id", () => {
	// 时间线改按轮窗口渲染后，空态判定看的是可见窗口（paginatedMessages）而不是全量 activeMessages。
	assert.match(timeline, /paginatedMessages\.length === 0/);
	assert.match(timeline, /<SessionStartSurface sessionId=\{sessionId\} \/>/);
});

// ACP 的历史存在 agent CLI 侧：激活重放之前时间线必然为空，但历史一定会填进来。
// 输入框必须在这个窗口期就钉在列底——否则用户先在居中起始页打字，重放落地那一刻
// 输入框从居中换到列底（卸载重建），正在输入的字与焦点一起丢。
test("ACP history restore window mounts the bottom composer instead of the centered start surface", () => {
	// 谓词层：空消息 + 不处于 loading + 历史待恢复 → 仍要挂底部栏
	const utils = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
	assert.match(utils, /isHistoryRestorePending\?: boolean/);
	assert.match(utils, /return input\.isHistoryRestorePending === true;/);
	// 会话视图把「ACP 历史待恢复」传进去
	assert.match(view, /useAcpHistoryRestorePending\(sessionId\)/);
	assert.match(view, /isHistoryRestorePending: acpRestorePending/);
	// 起始页同时退场，避免同屏两个输入框 + 重放落地时换宿主
	assert.match(timeline, /!acpRestorePending && <SessionStartSurface/);
	// 恢复提示条跟着搬到列底输入框上方（原位置在起始页里）
	assert.match(view, /<SessionAcpRestoreStrip sessionId=\{sessionId\} \/>/);
});

test("pi and DSH keep the existing behavior (no restore window)", () => {
	// 只有 ACP 会话（有 acpSessionId 且尚未激活）才判为待恢复；其他后端 hint 为 undefined
	const hint = readFileSync("src/renderer/src/utils/acpSessionRestore.ts", "utf8");
	assert.match(hint, /if \(!record \|\| record\.backend !== "acp"\) return undefined;/);
});

test("shouldMountBottomComposer: 空消息 + 历史待恢复时挂底部栏，否则保持原语义", () => {
	const { shouldMountBottomComposer } = loadTsCommonJs("src/renderer/src/rendererUtils.ts");
	// pi/dsh 的历史首帧就有消息，或处于 loading：沿用原行为
	assert.equal(shouldMountBottomComposer({ hasActiveConversation: true, messageCount: 0, isConversationLoading: true }), true);
	assert.equal(shouldMountBottomComposer({ hasActiveConversation: true, messageCount: 3, isConversationLoading: false }), true);
	assert.equal(shouldMountBottomComposer({ hasActiveConversation: true, messageCount: 0, isConversationLoading: false }), false);
	// ACP 激活重放窗口期：消息还是 0、也不 loading，但历史一定会来 → 输入框先钉在底部
	assert.equal(shouldMountBottomComposer({ hasActiveConversation: true, messageCount: 0, isConversationLoading: false, isHistoryRestorePending: true }), true);
	// 没有活跃会话时任何条件都不挂
	assert.equal(shouldMountBottomComposer({ hasActiveConversation: false, messageCount: 0, isConversationLoading: false, isHistoryRestorePending: true }), false);
});
