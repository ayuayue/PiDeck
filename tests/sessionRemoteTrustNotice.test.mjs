import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话 trust 条（P4.2 如实告知 → P4.4b 可决策 + 可撤销）。
 *
 * 这组用例锁三件事：
 * 1. **标记 → 是否渲染**（行为级，真 atom + 真事件）：`agents:state` 载荷带 `remoteTrustUnhandled: true`
 *    ⇒ 提示渲染；本地会话 / 旧 main 的载荷不带这个字段 ⇒ 不渲染，且整个链路不抛错。
 *    该标记仍然只是「这条会话是远端会话」的判据——父批明确要求不能改成「只有事件才显示」。
 * 2. **决策表 → 四态**（行为级）：未决策 / 已信任 / 已拒绝 / 因 endpoint 变更作废，全部由 PiDeck 自己的
 *    决策存储（主进程 `remoteProjectTrust` 段经 `remoteTrust:list` 下发）决定，不消费任何 pi 事件。
 * 3. **提示的形态**（源码级，本仓无 DOM 装置）：inline 条（未决策/作废常驻、已决定自动收起；不是一次性 toast）、四种状态与决策动作的
 *    双语文案 key 齐备、挂载点在会话头下方、设置页有清单入口、渲染层不出现任何 pin 材料
 *    （fingerprint / known_hosts / endpoint 摘要）字样、没有为它新增手写 CSS class。
 */
const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

const noticeSource = () => readFileSync("src/renderer/src/components/session/RemoteSessionTrustNotice.tsx", "utf8");
const viewSource = () => readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const SESSION_ID = "session-remote";
const AGENT_ID = "agent-remote";

/** `agents:state` 的载荷形状：主进程下发的是整条 AgentTab（远端分支会带 remoteTrustUnhandled）。 */
function agentsStateEvent(payload) {
	return {
		kind: "event",
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: {
			id: AGENT_ID,
			projectId: "project-remote",
			cwd: "/srv/remote-app",
			title: "远端会话",
			status: "idle",
			createdAt: 1,
			...payload,
		},
	};
}

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REMOTE_ROOT = "/srv/remote-app";

/** 远端项目：**项目**上的 ssh locator 才是 trust 判定对象（remotePath = canonical 项目根）。 */
const REMOTE_PROJECT = { id: "project-remote", name: "app", lastOpenedAt: 1, locator: { kind: "ssh", hostId: HOST_ID, remotePath: REMOTE_ROOT } };
const LOCAL_PROJECT = { id: "project-remote", name: "local app", lastOpenedAt: 1, path: "/home/dev/app" };

/** 主进程 `remoteTrust:*` 下发的条目形状（不含任何 pin 材料）。 */
function trustEntry(decision, status) {
	return {
		hostId: HOST_ID,
		hostLabel: "Build box",
		canonicalRoot: REMOTE_ROOT,
		decision,
		decidedAt: "2026-10-01T00:00:00.000Z",
		status,
		...(status === "stale" ? { staleReason: "endpoint-changed" } : {}),
	};
}

/** 一条已经是远端会话的 store：标记 + 项目清单都就位，剩下只差决策表。 */
function createRemoteSessionStore(project = REMOTE_PROJECT) {
	const store = createStore();
	store.set(atoms.replaceProjectInventoryAtom, [project]);
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	return store;
}

test("远端会话的 agents:state 载荷带标记 ⇒ 提示判据为 true", () => {
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
	// 标记落在会话自己的 runtime 视图状态上（按 sessionId 隔离，不是全局开关）。
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID]?.remoteTrustUnhandled, true);
});

test("本地/旧载荷不带标记 ⇒ 提示判据为 false，且不报错", () => {
	const store = createStore();
	// 情形 1：本地会话（现在的 tab 形状，压根没这个字段）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({}));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 2：显式 false（旧 payload / 未来的显式「已处理」形态）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: false }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 3：非布尔垃圾值不得把提示点亮（IPC 载荷不可信）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: "true" }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 4：没有任何 runtime 记录的会话照样返回 false，不抛错
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily("session-unknown")), false);
});

test("标记变化本身要触发 runtime 状态写入（不被「无变化」判定吞掉）", () => {
	const store = createStore();
	// 先来一条不带标记的同代事件（模拟标记到达前的状态），再来带标记的：
	// 「无变化」判定若漏比这个字段，第二次事件会被跳过写入，提示永远不出现。
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({}));
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
});

test("标记跟着会话走：send 路径的绑定刷新不把它抹掉", () => {
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	// bindSessionRuntimeAtom 是「只写绑定字段」的刷新（useSessionSend 在每次发送后调用）。
	store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: 1, status: "running" });
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
});

test("提示条：常驻 inline + 文案走 i18n + 无标记整体不渲染", () => {
	const notice = noticeSource();
	// 渲染判据：四态选择器的输入就是「静态标记 + 决策表」，标记缺失时整体返回 undefined ⇒ 直接 return null。
	assert.match(notice, /sessionRemoteTrustStateAtomFamily\(props\.sessionId\)/);
	assert.match(notice, /if \(state === undefined\) return null;/);
	// 双语文案 key（JSX 里禁止硬编码中英文）：四态标题 + 三个决策动作 + 失败提示。
	// key 以字符串字面量写在组件里的 COPY 表上（`t(copy.title)` 间接调用），并由 `TranslationKey` 类型兜住拼写。
	assert.match(notice, /const COPY: Record<"undecided" \| "approved" \| "denied" \| "stale", \{ icon: ReactNode; title: TranslationKey; hint: TranslationKey \}>/);
	for (const key of ["session.remoteTrust.title", "session.remoteTrust.approved.title", "session.remoteTrust.denied.title", "session.remoteTrust.stale.title", "session.remoteTrust.action.trust", "session.remoteTrust.action.deny", "session.remoteTrust.action.revoke", "session.remoteTrust.actionFailed"]) {
		assert.ok(notice.includes(`"${key}"`), `${key} 必须出现在组件里（走 i18n，不硬编码文案）`);
	}
	// 决策入口是真的按钮（`Button` 原语），不是只管展示的只读文案。
	assert.match(notice, /import \{ Button \} from "\.\.\/ui-shadcn\/button"/);
	assert.match(notice, /trust\.decide\(target, "approve"\)/);
	assert.match(notice, /trust\.decide\(target, "deny"\)/);
	assert.match(notice, /trust\.revoke\(target\)/);
	// 常驻 inline 条：不是一次性 toast（代码里不引 notice 工具/不弹窗；断言前先剥掉注释，
	// 因为「不是一次性 toast」这句说明本身出现在注释里）。
	const noticeCode = notice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\//gm, "");
	assert.doesNotMatch(noticeCode, /showNotice|utils\/notice|toast/i);
	// 会话头下方的挂载点（与分支条同层，时间线/引导页都在它下面）
	assert.match(viewSource(), /<RemoteSessionTrustNotice sessionId=\{sessionId\} \/>/);
});

test("已决定的两态自动收起：回执不常驻，待办（未决策/作废）仍常驻", () => {
	const notice = noticeSource();
	// 用户反馈：信任成功后那行「已信任远端项目」一直挂在会话头顶，每次看对话都要先读一遍规则。
	assert.match(notice, /export const REMOTE_TRUST_DECIDED_NOTICE_MS = 8_000;/);
	// 只有已决定（approved/denied）开始计时；未决策与作废需要人点，不能被定时器收走。
	assert.match(notice, /const decided = state\.kind === "approved" \|\| state\.kind === "denied";/);
	assert.match(notice, /if \(!decided\) return;/);
	assert.match(notice, /window\.setTimeout\(\(\) => setDismissed\(true\), REMOTE_TRUST_DECIDED_NOTICE_MS\)/);
	// 换会话/换态从头计时：状态里不能把上一会话的“已收起”带过来。
	assert.match(notice, /\[decided, props\.sessionId\]/);
	// 收起即整条不渲染（不是留在 DOM 里透明），且改主意有设置页清单兜底。
	assert.match(notice, /if \(dismissed\) return null;/);
	const settings = readFileSync("src/renderer/src/components/app/settings/RemoteProjectTrustPanel.tsx", "utf8");
	assert.match(settings, /trust\.revoke/, "设置页必须保留撤销入口，收起才不等于失去控制权");
});

test("四态来自决策表：未决策 / 已信任 / 已拒绝 / endpoint 变更作废（真 atom，非事件驱动）", () => {
	const store = createRemoteSessionStore();
	// 还没拉到清单（status idle 等价于「没有决策条目」）：未决策，且判定对象就是项目的 ssh locator。
	const undecided = store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID));
	assert.equal(undecided.kind, "undecided");
	assert.deepEqual({ ...undecided.target }, { hostId: HOST_ID, remoteRoot: REMOTE_ROOT });

	// 已信任（active）：条目来自主进程清单，界面只信它。
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [trustEntry("approve", "active")] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "approved");

	// 已拒绝。
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [trustEntry("deny", "active")] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "denied");

	// endpoint 变更 ⇒ 作废（带原因），界面必须能说明为什么。
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [trustEntry("approve", "stale")] });
	const stale = store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID));
	assert.equal(stale.kind, "stale");
	assert.equal(stale.entry.staleReason, "endpoint-changed");
	assert.equal(stale.entry.decision, "approve", "作废条目仍如实保留原决策供审计");
});

test("判定对象取项目 locator（不是会话 locator 的 remotePath）与主机隔离", () => {
	// 本机项目：没有 ssh locator ⇒ 仍是「未决策」但**没有**判定对象（决策按钮据此不可用）。
	const local = createRemoteSessionStore(LOCAL_PROJECT);
	const localState = local.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID));
	assert.equal(localState.kind, "undecided");
	assert.equal(localState.target, undefined);

	// 同一项目根、另一台主机的决策不得命中（信任是 (hostId, 根) 的联合身份）。
	const store = createRemoteSessionStore();
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [{ ...trustEntry("approve", "active"), hostId: "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f" }] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "undecided");

	// 同一主机、另一个项目根：同样不命中。
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [{ ...trustEntry("approve", "active"), canonicalRoot: "/srv/another-app" }] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "undecided");
});

test("非远端会话（无标记）⇒ 四态选择器为 undefined（不渲染、不报错）", () => {
	const store = createStore();
	store.set(atoms.replaceProjectInventoryAtom, [REMOTE_PROJECT]);
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [trustEntry("approve", "active")] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)), undefined);
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily("session-unknown")), undefined);
});

test("决策表加载/刷新后提示条跟着变（同一会话不必重启就更新）", () => {
	const store = createRemoteSessionStore();
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "undecided");
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [trustEntry("approve", "active")] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "approved");
	// 撤销（清单清空）⇒ 回到未决策。
	store.set(atoms.remoteProjectTrustStateAtom, { status: "ready", entries: [] });
	assert.equal(store.get(atoms.sessionRemoteTrustStateAtomFamily(SESSION_ID)).kind, "undecided");
});

test("设置页有「远端信任」清单入口：组件存在、挂在与主机同一页、四态文案齐备", () => {
	const panel = readFileSync("src/renderer/src/components/app/settings/RemoteProjectTrustPanel.tsx", "utf8");
	const connections = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
	assert.match(connections, /<RemoteProjectTrustPanel \/>/, "清单必须挂在远端设置页（与主机列表同页）");
	assert.match(panel, /t\("settings\.remoteTrust\.title"\)/);
	assert.match(panel, /t\("settings\.remoteTrust\.revoke"\)/);
	assert.match(panel, /entry\.canonicalRoot/, "清单必须显示判定对象（项目根）");
	assert.match(panel, /entry\.hostLabel/, "清单必须显示主机显示名");
	// 撤销动作落地在 trust 命令上（不是只读展示）。
	assert.match(panel, /trust\.revoke\(target\)/);
});

test("渲染层不得出现任何 pin 材料：trust 提示/清单/hook/atom 与渲染层可见的条目类型都没有", () => {
	// 扫的是**代码与文案**（不是注释）：注释里说明「这些材料不出主进程」是允许的，渲染层照着做才是要求。
	const codeOf = (file) =>
		readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^[\t ]*\/\//gm, "");
	for (const file of ["src/renderer/src/components/session/RemoteSessionTrustNotice.tsx", "src/renderer/src/components/app/settings/RemoteProjectTrustPanel.tsx", "src/renderer/src/hooks/useRemoteProjectTrust.ts", "src/renderer/src/atoms/remote-trust-atoms.ts"]) {
		assert.doesNotMatch(codeOf(file), /fingerprint|knownHosts|known_hosts|endpointDigest/i, `${file} 不得出现 pin 材料（指纹 / known_hosts / endpoint 摘要）`);
	}
	// 渲染层可见的条目类型同样装不下这些字段（结构上就传不过去）。
	const shared = readFileSync("src/shared/types/remoteTrust.ts", "utf8");
	const entryBlock = shared.slice(shared.indexOf("export type RemoteProjectTrustEntry"), shared.indexOf("export type RemoteProjectTrustListResult"));
	assert.doesNotMatch(entryBlock, /fingerprint|knownHosts|endpointDigest/i, "渲染层条目类型不得带 pin 材料");
	// 而主进程持有的记录**必须**带摘要（否则「同主机同根但 endpoint 变了」检测不出来）。
	const recordBlock = shared.slice(shared.indexOf("export type RemoteProjectTrustRecord"), shared.indexOf("export type RemoteProjectTrustEntry"));
	assert.match(recordBlock, /endpointDigest: string/, "记录必须带 endpoint 摘要：作废判定靠它");
});

test("两条文案在两个 locale 字典里都存在且非空", () => {
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"session\.remoteTrust\.title": "/);
		assert.match(locale, /"session\.remoteTrust\.hint": "[^"]+/);
	}
	assert.match(zh(), /"session\.remoteTrust\.hint": "[^"]*远端项目目录里的 \.pi 资源[^"]*"/);
	assert.match(en(), /"session\.remoteTrust\.hint": "[^"]*\.pi resources[^"]*"/);
});

test("提示用既有 Tailwind 语义 token，没有为它新增手写 CSS class", () => {
	const notice = noticeSource();
	assert.match(notice, /border-border-subtle/);
	assert.match(notice, /bg-bg-panel/);
	for (const name of readdirSync("src/renderer/src/styles")) {
		if (!name.endsWith(".css")) continue;
		assert.doesNotMatch(readFileSync(join("src/renderer/src/styles", name), "utf8"), /remote-?trust/i, `${name} 不应为远端 trust 提示新增手写 class`);
	}
});

test("标记不因绑定变化被抹掉：runtime 事件重建条目时保留会话级事实（真机 UI 验收回归）", () => {
	const store = createStore();
	// 先到一条带标记的 tab 快照（远端会话创建时的常态）。
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
	// 再模拟「输入首键预热 ⇒ runtime 重新绑定」：新代际 + 新 agent 会让 applySessionRuntimeEventAtom
	// 走「bindingChanged ⇒ 全新字面量」分支，而这条 runtime-state 载荷**不带** remoteTrustUnhandled
	// （只有 agents:state 的 tab 快照带）——此前的实现把会话级事实一起丢在这里，真机 UI 验收实测到的
	// 现象就是「输入首键之后 trust 提示从不出现」。
	store.set(atoms.applySessionRuntimeEventAtom, {
		kind: "event",
		sessionId: SESSION_ID,
		agentId: "agent-remote-2",
		runtimeGeneration: 2,
		sourceChannel: "agents:runtime-state",
		payload: { id: "agent-remote-2", state: { modelName: "remote-model" } },
	});
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID]?.agentId, "agent-remote-2", "绑定必须真的换到新 runtime");
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true, "会话级标记不得被 runtime 重建抹掉");
});
