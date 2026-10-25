import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 模拟消息、浏览器时钟与组件生命周期，验证重试提示本身会变而不是只测减法。 */
function retryMessage({ delayMs = 5000, timestamp = 10000, attempt = 1, status = "running" } = {}) {
	return {
		id: "retry-1",
		agentId: "agent-1",
		role: "system",
		timestamp,
		text: `正在自动重试 ${attempt}/10，${Math.ceil(delayMs / 1000)} 秒后重试`,
		meta: {
			status,
			delayMs,
			attempt,
			maxAttempts: 10,
			i18nKey: status === "running" ? "diagnostic.retryScheduledAfterDelay" : status === "success" ? "diagnostic.retrySucceeded" : "diagnostic.retryFailed",
			i18nParams: { count: `${attempt}/10`, attempt, delaySeconds: Math.ceil(delayMs / 1000) },
		},
	};
}

/** 找到实际行文案的 title；不执行无关图标/布局组件，也不依赖 JSX 层级。 */
function findLabel(node) {
	if (!node || typeof node !== "object") return undefined;
	if (typeof node.props?.title === "string") return node.props.title;
	const children = node.props?.children;
	for (const child of Array.isArray(children) ? children : [children]) {
		const label = findLabel(child);
		if (label !== undefined) return label;
	}
	return undefined;
}

async function countdownHarness({ now: initialNow = 10000, locale = "zh-CN" } = {}) {
	const host = quickMessageHookHost();
	const timers = new Map();
	let now = initialNow;
	let timerId = 0;
	let stateUpdates = 0;
	const load = createTsSandbox({
		stubs: {
			react: {
				...host.react,
				memo: (component) => component,
				useState(initial) {
					const [value, setValue] = host.react.useState(initial);
					return [
						value,
						(next) => {
							stateUpdates += 1;
							setValue(next);
						},
					];
				},
			},
			"lucide-react": { ChevronDown: "chevron-down", ChevronRight: "chevron-right", CircleCheck: "circle-check", CircleX: "circle-x", RefreshCw: "refresh" },
			"../TimelineMarker": { TimelineMarker: "timeline-marker" },
			"../../ui-shadcn/badge": { Badge: "badge" },
			// 折叠原语只关心受控开合的子树，stub 成占位标签即可（不执行 Radix 逻辑）。
			"../../ui-shadcn/collapsible": { Collapsible: "collapsible", CollapsibleContent: "collapsible-content" },
			"../TimelineFormat": { stripAnsi: (text) => text },
			"./StepTraceDetails": { resolveStepDetail: () => "", StepTraceDetails: () => null },
		},
		globals: {
			Date: class extends Date {
				static now() {
					return now;
				}
			},
			window: {
				setTimeout(callback, delay) {
					timers.set(++timerId, { callback, at: now + delay });
					return timerId;
				},
				clearTimeout: (id) => timers.delete(id),
			},
		},
	});
	// 词典按需加载：sandbox 里 import() 会被转成同步 require，await 只是让微任务结算。
	const i18n = load("src/renderer/src/i18n.ts");
	await i18n.ensureI18nLocale(locale);
	i18n.setI18nLocale(locale);
	const { RetryStep } = load("src/renderer/src/components/session/turn/RetryStep.tsx");
	return {
		render(message, hidden = false) {
			return findLabel(host.render(() => RetryStep({ group: { kind: "retry-group", id: message.id, message }, hidden })));
		},
		advanceBy(milliseconds) {
			now += milliseconds;
			// 故意允许跳过多个秒：模拟后台节流/主线程延迟，不能按 tick 次数慢慢补数。
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		unmount: host.unmount,
		get timerCount() {
			return timers.size;
		},
		get stateUpdates() {
			return stateUpdates;
		},
	};
}

test("重试行按实际延迟逐秒倒计时，保留次数且不修改原消息", async () => {
	for (const seconds of [5, 10, 30, 90]) {
		const h = await countdownHarness();
		const message = retryMessage({ delayMs: seconds * 1000 });
		const original = JSON.stringify(message);
		assert.equal(h.render(message), `正在自动重试 1/10，${seconds} 秒后重试`);
		assert.equal(h.timerCount, 1);
		const previousUpdates = h.stateUpdates;
		h.advanceBy(1000);
		assert.ok(h.stateUpdates > previousUpdates, "计时器必须触发 React 更新，无需新 RPC 消息");
		assert.equal(h.render(message), `正在自动重试 1/10，${seconds - 1} 秒后重试`);
		assert.equal(JSON.stringify(message), original, "倒计时只影响呈现，不回写会话消息");
		h.unmount();
		assert.equal(h.timerCount, 0);
	}
});

test("延迟挂载和后台节流按消息时间校准，到零后显示正在重试且停止计时", async () => {
	const h = await countdownHarness({ now: 12000 });
	const message = retryMessage();
	assert.equal(h.render(message), "正在自动重试 1/10，3 秒后重试");
	h.advanceBy(2500);
	assert.equal(h.render(message), "正在自动重试 1/10，1 秒后重试");
	h.advanceBy(500);
	assert.equal(h.render(message), "正在自动重试 1/10");
	assert.equal(h.timerCount, 0);
	h.advanceBy(60000);
	assert.equal(h.render(message), "正在自动重试 1/10");
	h.unmount();
});

test("不足整秒的退避向上取整，并在真实秒数边界更新", async () => {
	const h = await countdownHarness();
	const message = retryMessage({ delayMs: 1500 });
	assert.equal(h.render(message), "正在自动重试 1/10，2 秒后重试");
	h.advanceBy(500);
	assert.equal(h.render(message), "正在自动重试 1/10，1 秒后重试");
	h.advanceBy(1000);
	assert.equal(h.render(message), "正在自动重试 1/10");
	assert.equal(h.timerCount, 0);
	h.unmount();
});

test("下一次退避立即使用新次数和新延迟，成功/失败清理计时器", async () => {
	for (const status of ["success", "error"]) {
		const h = await countdownHarness();
		h.render(retryMessage());
		h.advanceBy(2000);
		const next = retryMessage({ timestamp: 12000, attempt: 2, delayMs: 30000 });
		assert.equal(h.render(next), "正在自动重试 2/10，30 秒后重试");
		assert.equal(h.timerCount, 1, "旧退避计时器应被清理，不能叠加");
		const final = retryMessage({ timestamp: 12000, attempt: 2, status });
		assert.equal(h.render(final), status === "success" ? "自动重试成功，共重试 2 次" : "自动重试失败，已重试 2/10 次");
		assert.equal(h.timerCount, 0);
		h.unmount();
	}
});

test("折叠停止计时，重新展开按当前剩余秒数恢复，卸载清理计时器", async () => {
	const h = await countdownHarness();
	const message = retryMessage({ delayMs: 30000 });
	h.render(message);
	h.render(message, true);
	assert.equal(h.timerCount, 0);
	h.advanceBy(12000);
	assert.equal(h.render(message), "正在自动重试 1/10，18 秒后重试");
	assert.equal(h.timerCount, 1);
	h.unmount();
	assert.equal(h.timerCount, 0);
});

test("英文使用同一实时倒计时，不依赖中文正文或固定秒数", async () => {
	const h = await countdownHarness({ locale: "en-US" });
	const message = retryMessage({ delayMs: 30000 });
	assert.equal(h.render(message), "Automatically retrying (1/10) in 30 seconds");
	h.advanceBy(3000);
	assert.equal(h.render(message), "Automatically retrying (1/10) in 27 seconds");
	h.unmount();
});

test("过期历史与非等待重试不启动计时器，未知延迟保持原文案", async () => {
	const h = await countdownHarness({ now: 20000 });
	assert.equal(h.render(retryMessage()), "正在自动重试 1/10");
	assert.equal(h.timerCount, 0);
	const message = retryMessage({ timestamp: 20000 });
	delete message.meta.delayMs;
	assert.equal(h.render(message), "正在自动重试 1/10，5 秒后重试");
	assert.equal(h.timerCount, 0);
	message.meta.i18nKey = "diagnostic.retryScheduled";
	assert.equal(h.render(message), "正在自动重试 1/10");
	assert.equal(h.timerCount, 0);
	h.unmount();
});
