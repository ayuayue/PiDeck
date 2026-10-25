import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * ACP 会话身份回归（tab/侧栏 logo 丢失 + 运行态 backend 被渲染层丢弃）：
 * 1) 运行时事件里的 backend="acp" 必须被接受（否则侧栏 Agent 行回退 "pi"，品牌徽标 null）；
 * 2) ACP 无 filePath 也必须可显示（否则重启/释放运行时后 ACP 会话整行从侧栏消失）；
 * 3) tab/侧栏各行用 AcpBackendMark（工具品牌图标）而不是通用文本徽标；
 * 4) ACP 行标题不允许空白（untitled 兜底）。
 * 源码正则扫描契约：空白容忍（\s*），改格式不断言。
 */

const read = (path) => readFileSync(path, "utf8");

const sessionAtoms = read("src/renderer/src/atoms/session-atoms.ts");
const sessionRecordDisplay = read("src/renderer/src/utils/sessionRecordDisplay.ts");
const sourceBadge = read("src/renderer/src/components/session/SessionSourceBadge.tsx");
const tabsBar = read("src/renderer/src/components/session/SessionTabsBar.tsx");
const activeTree = read("src/renderer/src/components/sidebar/ActiveSessionsTree.tsx");
const sessionTree = read("src/renderer/src/components/sidebar/SessionTree.tsx");
const recentSection = read("src/renderer/src/components/sidebar/RecentSessionsSection.tsx");

test("运行时事件 backend=acp 必须被渲染层接受（不得只认 dsh）", () => {
	assert.match(sessionAtoms, /payload\.backend\s*===\s*"dsh"\s*\|\|\s*payload\.backend\s*===\s*"acp"\s*\?\s*payload\.backend\s*:/, "applySessionRuntimeEvent 的 backend 合并必须同时接受 dsh 与 acp，否则侧栏 ACP 行回退 pi、品牌徽标消失");
});

test("isDisplayableSessionRecord 把 backend=acp 视为可显示", () => {
	const { isDisplayableSessionRecord } = loadTsCommonJs("src/renderer/src/utils/sessionRecordDisplay.ts");
	assert.equal(isDisplayableSessionRecord({ filePath: null, backend: "acp" }), true, "ACP 会话无文件也必须在侧栏可见");
	assert.equal(isDisplayableSessionRecord({ filePath: null, backend: undefined }), false, "pi 会话无文件仍不可显示（回归锚点）");
	assert.equal(isDisplayableSessionRecord({ filePath: "C:\\a.jsonl", backend: undefined }), true);
});

test("SessionSourceBadge 提供 AcpBackendMark（按 acpToolId 解析品牌，与 AcpToolLogo 同源）", () => {
	assert.match(sourceBadge, /export\s+function\s+AcpBackendMark\s*\(/);
	assert.match(sourceBadge, /acpToolsAtom/);
});

test("tab 栏 ACP 徽标走 AcpBackendMark 品牌图标", () => {
	assert.match(tabsBar, /AcpBackendMark/);
	assert.match(tabsBar, /record\??\.acpToolId/);
});

test("活动会话树 ACP 行走品牌图标且标题有 untitled 兜底", () => {
	assert.match(activeTree, /agent\.backend\s*===\s*"acp"\s*\?\s*<AcpBackendMark\s+acpToolId=\{record\?\.acpToolId\}\s*\/>/);
	assert.match(activeTree, /summary\?\.name\s*\|\|\s*agent\.title\s*\|\|\s*t\("common\.untitled"\)/);
});

test("项目树三类行（agent/历史/草稿）ACP 行均走品牌图标", () => {
	assert.match(sessionTree, /child\.agent\.backend\s*===\s*"acp"\s*\?\s*<AcpBackendMark\s+acpToolId=\{agentSession\?\.acpToolId\}\s*\/>/);
	assert.match(sessionTree, /child\.session\.backend\s*===\s*"acp"\s*\?\s*<AcpBackendMark\s+acpToolId=\{child\.session\.acpToolId\}\s*\/>/);
	assert.match(sessionTree, /session\.backend\s*===\s*"acp"\s*\?\s*<AcpBackendMark\s+acpToolId=\{session\.acpToolId\}\s*\/>/);
	// 草稿行与 agent 行标题兜底（空白标题会留一条看不见的空横条）
	assert.match(sessionTree, /text=\{session\.title\s*\|\|\s*t\("common\.untitled"\)\}/);
});

test("最近会话区 ACP 行走品牌图标", () => {
	assert.match(recentSection, /row\.session\.backend\s*===\s*"acp"\s*\?\s*<AcpBackendMark\s+acpToolId=\{row\.session\.acpToolId\}\s*\/>/);
});

test("ACP 行按 deckSessionId 绑回自己的会话，不得误绑无 filePath 记录", () => {
	// 回归（2026-10）：无 sessionPath 的 ACP Agent 与同为 filePath=undefined 的草稿记录
	// 「undefined === undefined」误绑，活动行显别人的标题，真正的会话又重复出现在「最近」（同一会话两行）。
	const { resolveBoundSession } = loadTsCommonJs("src/renderer/src/components/sidebar/activitySessionsModel.ts");
	const own = { id: "deck-acp", projectId: "p1", title: "你好", updatedAt: 7, status: "active", filePath: undefined, backend: "acp" };
	const decoy = { id: "deck-draft", projectId: "p1", title: "你好", updatedAt: 99, status: "draft", filePath: undefined };
	const agent = { id: "acp:1", projectId: "p1", title: "你好", status: "running", backend: "acp", createdAt: 1, sessionPath: undefined, deckSessionId: "deck-acp" };
	assert.equal(resolveBoundSession(agent, [decoy, own], {})?.id, "deck-acp");
	assert.equal(resolveBoundSession({ ...agent, deckSessionId: undefined }, [decoy, own], {}), undefined);
	// 两处 Agent 行绑定（项目树 ×2）都必须走同一个解析器；模型内部（活动页）也用同一份判定
	assert.equal((sessionTree.match(/resolveBoundSession\(/g) ?? []).length, 2);
	const model = read("src/renderer/src/components/sidebar/activitySessionsModel.ts");
	assert.match(model, /const bound = resolveBoundSession\(agent, sessions, catalog\.runtimeBySessionId\)/);
});
