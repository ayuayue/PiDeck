import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseBusySendDelivery, resolveBusySendDelivery } = loadTsCommonJs("src/shared/busySendDelivery.ts");

/** 忙碌时发送的统一投递语义（shared/busySendDelivery.ts）：解析容错 + 忙/闲决策。 */
describe("parseBusySendDelivery", () => {
	test("合法值原样返回", () => {
		assert.equal(parseBusySendDelivery("steer"), "steer");
		assert.equal(parseBusySendDelivery("followUp"), "followUp");
	});

	test("非法/缺省值回落默认 steer（磁盘 JSON 无类型，坏值不抛错）", () => {
		assert.equal(parseBusySendDelivery(undefined), "steer");
		assert.equal(parseBusySendDelivery(null), "steer");
		assert.equal(parseBusySendDelivery(""), "steer");
		assert.equal(parseBusySendDelivery("queue"), "steer");
		assert.equal(parseBusySendDelivery(1), "steer");
		assert.equal(parseBusySendDelivery({}), "steer");
	});
});

describe("resolveBusySendDelivery", () => {
	test("空闲时返回 undefined：直发，不带队列语义", () => {
		assert.equal(resolveBusySendDelivery(false, "followUp"), undefined);
		assert.equal(resolveBusySendDelivery(false, undefined), undefined);
	});

	test("忙碌时按配置返回投递语义", () => {
		assert.equal(resolveBusySendDelivery(true, "steer"), "steer");
		assert.equal(resolveBusySendDelivery(true, "followUp"), "followUp");
	});

	test("忙碌且未配置时回落 steer（与出厂默认一致）", () => {
		assert.equal(resolveBusySendDelivery(true, undefined), "steer");
	});
	test("ACP 后端忙碌恒 followUp：协议无 steer 通道，设置项对它失效", () => {
		assert.equal(resolveBusySendDelivery(true, "steer", "acp"), "followUp");
		assert.equal(resolveBusySendDelivery(true, "followUp", "acp"), "followUp");
		assert.equal(resolveBusySendDelivery(true, undefined, "acp"), "followUp");
	});
	test("ACP 后端空闲仍直发（无需队列语义）", () => {
		assert.equal(resolveBusySendDelivery(false, "steer", "acp"), undefined);
	});
	test("其他后端不受影响：缺省 backend 按设置照常解析", () => {
		assert.equal(resolveBusySendDelivery(true, "steer", "pi"), "steer");
		assert.equal(resolveBusySendDelivery(true, "followUp", "dsh"), "followUp");
		assert.equal(resolveBusySendDelivery(true, "steer"), "steer");
	});
});

/**
 * 回归保护：忙碌时默认投递行为由设置项统一决定，pi/dsh 不再在 UI 层按后端分叉。
 * （历史行为：pi 忙碌默认 steer、dsh 默认 followUp；现统一走 busySendDelivery 设置，
 * 各后端差异下沉到主进程 wire 映射。）
 */
describe("busy send delivery decision points", () => {
	const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	const promptDispatchSource = readFileSync("src/renderer/src/hooks/session/useSessionPromptDispatch.ts", "utf8");
	const historyMutationsSource = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");

	test("composer 发送入口消费 resolveBusySendDelivery，不再按后端分叉", () => {
		assert.ok(composer.includes("resolveBusySendDelivery(isBusy"));
		assert.doesNotMatch(composer, /isDshBackend\s*\?\s*"followUp"\s*:\s*"steer"/);
		// 死代码已删除：delivery.steer / delivery.followUp 菜单从未被任何组件接线
		assert.doesNotMatch(composer, /steer:\s*\(\)\s*=>\s*\{[^}]*promoteAndSend\("steer"\)/);
		assert.doesNotMatch(composer, /followUp:\s*\(\)\s*=>\s*\{/);
	});

	test("App 入队兜底与非队列入口同样走设置，不读 backend", () => {
		// 非队列入口的投递语义解析随 submitPromptSnapshot 迁入 useSessionPromptDispatch。
		assert.ok(promptDispatchSource.includes("resolveBusySendDelivery("));
		assert.ok(appSource.includes("behavior: snapshot.behavior ?? store.get(busySendDeliveryAtom)"));
		assert.doesNotMatch(appSource, /backend === "dsh"\s*\?\s*"followUp"\s*:\s*"steer"/);
		// atom 与 settings 同步，设置保存后无需重挂载会话
		assert.match(appSource, /setBusySendDelivery\(settings\.busySendDelivery\)/);
	});

	test("fork 化重发/编辑把 requireAppliedModel 透传给 sendPrompt（issue #370）", () => {
		// 两个坑：一是重发/编辑忘了带标记（核对根本不跑），二是带了却没写进 IPC 载荷。
		assert.match(historyMutationsSource, /requireAppliedModel:\s*true/);
		assert.match(promptDispatchSource, /options\?\.requireAppliedModel\s*\?\s*\{\s*requireAppliedModel:\s*true\s*\}\s*:\s*\{\s*\}/);
	});
});
