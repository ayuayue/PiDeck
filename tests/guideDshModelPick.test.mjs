import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * issue #253：引导页切 DSH 后模型选不了——点选被静默丢弃，底栏显示 pi 模型。
 *
 * 用户可见症状：在项目引导页（无 SessionRecord 的空白输入框）把后端切到 DSH，
 * 模型选择器里点任何模型都没反应；底栏显示的是 pi 的默认模型（配置页/prod 里
 * 甚至显示 `my-provider/some-pi-model`），而不是 DSH 目录里的选择。
 *
 * 本文件锁定「引导页 + DSH」这条链路的端到端不变量：
 *   1. 点选必须被持久化（不能像改造前那样直接 return 丢掉）；
 *   2. 持久化的偏好必须回显到底栏/选择器高亮（选了什么就显示什么）；
 *   3. 首次发送时该偏好必须作为显式模型带到 createDraft（否则 host 用部署默认）；
 *   4. pi 与 DSH 的引导页偏好互不污染（各自独立存储）。
 *
 * 修复前的失败形态记录在各用例的断言消息里，便于回归时一眼看出退化点。
 */

/** 最小 localStorage 替身：跨 sandbox 共享同一份存储，模拟同一渲染进程。 */
function createLocalStorage() {
	const store = new Map();
	return {
		store,
		api: {
			getItem: (key) => (store.has(key) ? store.get(key) : null),
			setItem: (key, value) => void store.set(key, String(value)),
			removeItem: (key) => void store.delete(key),
			clear: () => store.clear(),
		},
	};
}

function loadBootstrap(localStorage) {
	const load = createTsSandbox({ globals: { localStorage } });
	return load("src/renderer/src/utils/chatSessionBootstrap.ts");
}

const { resolveGuideDisplayModel } = loadTsCommonJs("src/renderer/src/utils/modelPendingDisplay.ts");

/** vm 沙箱里创建的对象原型与测试 realm 不同，deepStrictEqual 会误报；JSON 往返归一到宿主 realm。 */
const plain = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);

// ── 1. 引导页 DSH 点选必须持久化，且与 pi 偏好隔离 ──────────────────────────

test("引导页 DSH 点选写入独立偏好键，不污染 pi 的欢迎页偏好", () => {
	const { api, store } = createLocalStorage();
	const bootstrap = loadBootstrap(api);

	assert.equal(typeof bootstrap.readWelcomeDshModelPreference, "function", "需要 DSH 专用的引导页偏好读取器");
	assert.equal(typeof bootstrap.WELCOME_DSH_MODEL_KEY, "string", "需要 DSH 专用的引导页偏好存储键");

	// pi 与 dsh 的键必须不同：同一个 key 会让两套解析互相读到对方的模型。
	assert.notEqual(bootstrap.WELCOME_DSH_MODEL_KEY, bootstrap.WELCOME_MODEL_KEY);

	store.set(bootstrap.WELCOME_DSH_MODEL_KEY, JSON.stringify({ provider: "jiyuan", modelId: "deepseek-flash", modelName: "deepseek-flash" }));
	assert.deepEqual(plain(bootstrap.readWelcomeDshModelPreference()?.model), { provider: "jiyuan", modelId: "deepseek-flash", modelName: "deepseek-flash" });
	// pi 偏好仍为「无」：DSH 的选择没有泄漏进 pi 解析。
	assert.equal(bootstrap.readWelcomeModelPreference(), undefined);
});

test("引导页 DSH 偏好：名称缺失/空白回退 modelId，脏数据不抛错", () => {
	const { api, store } = createLocalStorage();
	const bootstrap = loadBootstrap(api);

	store.set(bootstrap.WELCOME_DSH_MODEL_KEY, JSON.stringify({ provider: "jiyuan", modelId: "deepseek-flash", modelName: "   " }));
	assert.equal(bootstrap.readWelcomeDshModelPreference()?.model.modelName, "deepseek-flash");

	store.set(bootstrap.WELCOME_DSH_MODEL_KEY, JSON.stringify({ provider: "jiyuan" }));
	assert.equal(bootstrap.readWelcomeDshModelPreference(), undefined, "半结构视为无偏好");

	store.set(bootstrap.WELCOME_DSH_MODEL_KEY, "not json");
	assert.equal(bootstrap.readWelcomeDshModelPreference(), undefined, "脏数据不抛错");
});

// ── 2. DSH 引导页展示：点选必须优先于部署默认 ────────────────────────────────

test("resolveGuideDisplayModel：DSH 点选优先于部署默认（回归 #253 的「切不动」）", () => {
	// 修复前：isDsh 分支直接返回 defaultModel，点选被丢弃——用户表现为「切不动」。
	assert.deepEqual(
		plain(
			resolveGuideDisplayModel({
				isDsh: true,
				welcomeModel: { provider: "jiyuan", modelId: "deepseek-flash", modelName: "deepseek-flash" },
				defaultModel: { provider: "deepseek-official", modelId: "deepseek-flash" },
			}),
		),
		{ provider: "jiyuan", modelId: "deepseek-flash", modelName: "deepseek-flash" },
		"DSH 点选被部署默认覆盖：模型路由由 host settings 决定，但 host 允许 sessions.selectModel 运行中换模型",
	);
});

test("resolveGuideDisplayModel：DSH 无点选时才用部署默认", () => {
	assert.deepEqual(plain(resolveGuideDisplayModel({ isDsh: true, defaultModel: { provider: "dsh-host", modelId: "agent-default" } })), { provider: "dsh-host", modelId: "agent-default" });
});

test("resolveGuideDisplayModel：pi 点选不得泄漏到 DSH（后端隔离）", () => {
	// pi 偏好与 DSH 偏好分开存储后，调用方仍可能误传：纯函数层面必须以后端为准。
	assert.deepEqual(plain(resolveGuideDisplayModel({ isDsh: true, defaultModel: { provider: "dsh-host", modelId: "agent-default" } })), { provider: "dsh-host", modelId: "agent-default" });
});

// ── 3. 首次发送必须把 DSH 偏好作为显式模型带入 ────────────────────────────────

test("首次发送：DSH 会话把引导页点选作为显式 model 传给 createDraft", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const body = app.slice(app.indexOf("const ensureSessionForSend = useCallback("), app.indexOf("// 把用户消息搬进真实会话缓存"));
	// 后端为 dsh 时必须读 DSH 偏好（pi 偏好在 DSH 会话下语义不适用）。
	assert.match(body, /readWelcomeDshModelPreference\(\)/, "首次发送没有读取 DSH 引导页偏好 → host 只能用部署默认（issue #253 症状 3）");
	// 该偏好必须作为 model 传入（不是 welcomeModel：welcomeModel 是 pi 侧的解析输入）。
	assert.match(body, /model:\s*(welcomeModel|draftModel)/, "DSH 点选没有作为显式 model 传给 createDraft");
});
