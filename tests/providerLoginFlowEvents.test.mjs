import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 登录流程「授权入口 / 事件流裁剪 / 自动打开浏览器」的契约。
 *
 * 为什么要有：这三件事都被用户当成 bug 报过——提示写着「已在系统浏览器打开授权页」但实际没打开、
 * 等一会儿验证码从界面上消失、没有入口时界面只转圈不说在等谁（截图里就是 github-copilot
 * 的 Enterprise 域名提问页）。判定逻辑现在都在 `utils/providerLoginFlow.ts` 里，这里锁行为。
 *
 * 断言一律比字段而不是整个对象：模块经 vm 新上下文加载，对象原型与测试进程不同，
 * `deepEqual`（strict）会因原型不等而误报。
 */
const flow = loadTsCommonJs("src/renderer/src/utils/providerLoginFlow.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
const read = (path) => readFileSync(path, "utf8");

const VERIFY_URI = "https://github.com/login/device";
const deviceCode = (code) => ({ type: "device_code", userCode: code, verificationUri: VERIFY_URI, intervalSeconds: 5, expiresInSeconds: 900 });
const progress = (message) => ({ type: "progress", message });

test("授权入口取最新一条：重签发的验证码覆盖旧码", () => {
	const entry = flow.pickProviderAuthEntry([deviceCode("OLD"), progress("polling"), deviceCode("NEW")]);
	assert.ok(entry, "事件流里有 device_code 就必须识别出授权入口");
	assert.equal(entry.kind, "device-code");
	assert.equal(entry.userCode, "NEW");
	assert.equal(entry.verificationUri, VERIFY_URI);
});

test("只有进度/提示时没有授权入口", () => {
	assert.equal(flow.pickProviderAuthEntry([progress("waiting"), { type: "info", message: "hi" }]), undefined);
	assert.equal(flow.pickProviderAuthEntry([]), undefined);
});

test("授权入口地址：设备码走验证页，OAuth 走授权页", () => {
	assert.equal(flow.authorizationEntryUrl({ kind: "device-code", userCode: "X", verificationUri: VERIFY_URI }), VERIFY_URI);
	assert.equal(flow.authorizationEntryUrl({ kind: "auth-url", url: "https://claude.ai/oauth/authorize" }), "https://claude.ai/oauth/authorize");
	assert.equal(flow.authorizationEntryUrl(undefined), undefined);
});

test("轮询进度刷屏也不能把验证码挤出事件流", () => {
	let events = [deviceCode("KEEP-ME")];
	for (let index = 0; index < 100; index += 1) events = flow.appendFlowEvent(events, progress(`poll ${index}`), 20);
	const entry = flow.pickProviderAuthEntry(events);
	assert.ok(entry, "100 条进度事件后验证码必须还在");
	assert.equal(entry.userCode, "KEEP-ME");
	const log = flow.pickFlowLogEvents(events).map((event) => event.message);
	assert.equal(log.length, 20, "日志区仍按上限裁剪");
	assert.equal(log.at(-1), "poll 99", "保留的是最近的进度");
});

test("新验证码替换旧验证码：入口只留最新一条", () => {
	const events = flow.appendFlowEvent([deviceCode("OLD")], deviceCode("NEW"), 20);
	const entry = flow.pickProviderAuthEntry(events);
	assert.equal(entry.userCode, "NEW");
	assert.equal(flow.pickFlowLogEvents(events).length, 0, "旧码不能留在日志区里诱导用户点错");
});

test("日志区丢掉授权入口，进度与提示保持顺序", () => {
	const events = [progress("a"), deviceCode("C"), { type: "info", message: "b" }];
	assert.deepEqual(
		flow.pickFlowLogEvents(events).map((event) => event.message),
		["a", "b"],
	);
});

test("同一个授权地址只自动打开一次", () => {
	const opened = new Set();
	const entry = flow.pickProviderAuthEntry([deviceCode("C")]);
	assert.equal(flow.pickPendingExternalOpen(entry, opened), VERIFY_URI);
	opened.add(VERIFY_URI);
	assert.equal(flow.pickPendingExternalOpen(entry, opened), undefined, "pi 重推同一条事件不该再次抢浏览器前台");
	assert.equal(flow.pickPendingExternalOpen(undefined, new Set()), undefined);
});

test("登录 hook 真的会打开系统浏览器（不能只显示「已打开」）", () => {
	const source = read("src/renderer/src/hooks/useProviderLoginFlow.ts");
	assert.match(source, /pickPendingExternalOpen\s*\(/, "要用「按地址去重」的判定决定是否打开");
	assert.match(source, /openedExternalRef\.current\.add\s*\(/, "打开过的地址要记下来去重");
	assert.match(source, /openInSystemBrowser\s*\(/, "必须真的调用系统浏览器打开");
});

test("弹框渲染授权入口卡与常驻代理提示", () => {
	const modal = read("src/renderer/src/components/app/ProviderLoginModal.tsx");
	assert.match(modal, /<AuthEntryCard\s/, "授权入口要有独立卡片（打开/复制是主操作）");
	assert.match(modal, /pickProviderAuthEntry\s*\(/, "入口由事件流派生，不在组件里 some()");
	assert.match(modal, /providerLogin\.running\.proxyHint/, "等待链接时常驻代理提示，不能只靠 15 秒后的慢提示");
	assert.match(modal, /providerLogin\.running\.awaitingAnswer/, "pi 在等用户回答时要说清在等谁");
});

test("自动打开失败时提示说实情（不再空报「已打开」）", () => {
	const hook = read("src/renderer/src/hooks/useProviderLoginFlow.ts");
	assert.match(hook, /openInSystemBrowser\s*\(url\)\s*\.then/, "要拿到打开结果才知道能不能说「已打开」");
	assert.match(hook, /setExternalOpenFailed\s*\(/, "打开失败要记下来给弹框选文案");
	const modal = read("src/renderer/src/components/app/ProviderLoginModal.tsx");
	assert.match(modal, /flow\.externalOpenFailed\s*\?/, "弹框按打开结果选文案");
	assert.match(modal, /providerLogin\.running\.linkReadyManualHint/);
	const util = read("src/renderer/src/utils/openExternal.ts");
	assert.match(util, /function\s+openInSystemBrowser\s*\(\s*url:\s*string\s*\)\s*:\s*Promise<boolean>/, "工具函数要回传是否真的打开了");
});

test("新增文案中英齐备，且删掉被替换的旧 key", () => {
	const keys = [
		"providerLogin.running.awaitingAnswer",
		"providerLogin.running.awaitingLink",
		"providerLogin.running.proxyHint",
		"providerLogin.running.openAuthPage",
		"providerLogin.running.deviceCodeHint",
		"providerLogin.running.copyCode",
		"providerLogin.running.copyLink",
		"providerLogin.running.linkReadyHint",
		"providerLogin.running.linkReadyManualHint",
	];
	for (const key of keys) {
		assert.ok(Object.hasOwn(zhCN, key), `zh-CN 缺 ${key}`);
		assert.ok(Object.hasOwn(enUS, key), `en-US 缺 ${key}`);
	}
	assert.ok(!Object.hasOwn(zhCN, "providerLogin.running.browserHint"), "旧 browserHint 已被 linkReadyHint 取代");
	assert.ok(!Object.hasOwn(enUS, "providerLogin.running.browserHint"), "旧 browserHint 已被 linkReadyHint 取代");
	assert.ok(!Object.hasOwn(zhCN, "providerLogin.method.oauthHint"), "运行阶段的空态文案已改为状态相关");
	assert.ok(!Object.hasOwn(enUS, "providerLogin.method.oauthHint"), "运行阶段的空态文案已改为状态相关");
});

test("代理提示必须点名具体开关，而不是「去设置里配代理」", () => {
	assert.match(zhCN["providerLogin.running.proxyHint"], /pi agent 代理/, "中文提示要指向「设置 → 代理设置 → 启用 pi agent 代理」");
	assert.match(zhCN["providerLogin.running.slowHint"], /pi agent 代理/);
	assert.match(enUS["providerLogin.running.proxyHint"], /pi agent proxy/i);
	assert.match(enUS["providerLogin.running.slowHint"], /pi agent proxy/i);
});
