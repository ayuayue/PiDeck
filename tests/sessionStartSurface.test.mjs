import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
	// DeepSeek 式居中：flex 列 + 重心下移（pt-[18vh] 压向视口中心）；
	// 2026-11 整体放大：Logo 72 / 980px / 高 300；快捷项按钮已按用户要求移除
	// 2027-02 用户反馈输入框偏小：容器 980→1080px，并在本页把内容宽度百分比提到 100%，
	// 否则内容宽度设置（默认 80%）会在 1080 里再收一刀，实际还是 784px
	assert.match(surface, /pt-\[18vh\]/);
	assert.match(surface, /max-w-\[1080px\]/);
	assert.match(surface, /\[--chat-content-pct-set:100%\]/);
	assert.doesNotMatch(surface, /defaultHeight=/);
	assert.match(surface, /session-start-surface/);
	// 移除快捷项后不再存在相关常量/交互代码
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
	assert.match(timeline, /activeMessages\.length === 0/);
	assert.match(timeline, /<SessionStartSurface sessionId=\{sessionId\} \/>/);
});
