import { readFileSync } from "node:fs";
import { it } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Notification Stack 收纳条的计数链路断言。
 * 背景：sonner 只堆叠展示最近 VISIBLE_TOAST_COUNT 条，洪峰时旧 toast 沉入堆叠
 * 用户看不见；右下角收纳条据「活跃 id 集合」显示 +N 并打开历史面板。
 * 关键不变量：计数以 showNotice 的 noticeId 为账本，onDismiss 按同一 id 幂等销账，
 * 任何路径（重复弹同 id / 重复 dismiss）都不能把账减穿或漏销。
 */

function loadNoticeWithRealStore() {
	const sonnerCalls = [];
	const sandbox = createTsSandbox({
		stubs: {
			react: { createElement: (component, props) => ({ component, props }) },
			sonner: {
				toast: {
					custom: (render, options) => sonnerCalls.push({ render, options }),
					dismiss: (id) => sonnerCalls.push({ dismissed: id }),
				},
			},
			"../components/ui-shadcn/notice-toast": { NoticeToastCard: () => null },
			"../i18n": { t: (key) => key },
			"./clipboard": { writeClipboard: async () => true },
			"./noticeHistory": { recordNoticeHistory: () => undefined },
		},
		globals: { document: undefined, window: undefined, CSS: { escape: (v) => v } },
	});
	// noticeCountStore 不 stub：真实模块随 notice.ts 的相对 import 一并加载，
	// 断言的就是生产链路本身。
	const notice = sandbox("src/renderer/src/utils/notice.ts");
	const store = sandbox("src/renderer/src/utils/noticeCountStore.ts");
	notice.setToasterReady(true);
	return { notice, store, sonnerCalls };
}

it("收纳条账本：showNotice 逐条入账，sonner onDismiss 回调按 id 销账", () => {
	const { notice, store, sonnerCalls } = loadNoticeWithRealStore();

	notice.showNotice("一", 1000);
	notice.showNotice("二", 1000, "error");
	assert.equal(store.getActiveNoticeCount(), 2);

	sonnerCalls[0].options.onDismiss();
	assert.equal(store.getActiveNoticeCount(), 1);
	sonnerCalls[1].options.onDismiss();
	assert.equal(store.getActiveNoticeCount(), 0);
});

it("同 id 顶掉不虚高：稳定 id 重复弹出仍只占一个活跃位（Set 幂等）", () => {
	const { notice, store, sonnerCalls } = loadNoticeWithRealStore();

	notice.showNotice("重试 1", 1000, undefined, undefined, undefined, "retry");
	notice.showNotice("重试 2", 1000, undefined, undefined, undefined, "retry");
	assert.equal(store.getActiveNoticeCount(), 1, "同 id 再弹是替换不是新增");

	// 首弹闭包与后弹闭包先后触发（sonner 合并选项时旧 onDismiss 仍可能跑一次）：
	// 只应销账一次，第二次是 no-op 而不是负数
	sonnerCalls[0].options.onDismiss();
	sonnerCalls[1].options.onDismiss();
	assert.equal(store.getActiveNoticeCount(), 0);
});

it("溢出阈值：≤ 可见堆叠数不提示，超出部分即收纳条显示的 N", () => {
	const { notice, store } = loadNoticeWithRealStore();
	for (let i = 0; i < store.VISIBLE_TOAST_COUNT; i += 1) notice.showNotice(`t${i}`, 1000);
	assert.equal(store.getActiveNoticeOverflow(), 0, "恰好铺满可见堆叠时无需收纳");
	notice.showNotice("第五条", 1000);
	notice.showNotice("第六条", 1000, "warning");
	assert.equal(store.getActiveNoticeOverflow(), 2, "超出可见数的条数应等于收纳条 N");
});

it("store 原语：remove 未知 id 不减穿、订阅可退订", () => {
	const store = createTsSandbox()("src/renderer/src/utils/noticeCountStore.ts");
	store.removeActiveNotice("ghost");
	assert.equal(store.getActiveNoticeCount(), 0, "不存在的 id 不应产生负数");

	let notified = 0;
	const unsubscribe = store.subscribeActiveNoticeCount(() => {
		notified += 1;
	});
	store.addActiveNotice("a");
	store.addActiveNotice("a");
	assert.equal(notified, 1, "幂等的第二次 add 不应再发通知");
	unsubscribe();
	store.removeActiveNotice("a");
	assert.equal(notified, 1, "退订后不再收到通知");
});

it("Toaster 与计数 store 同源可见数：visibleToasts 不许再写死字面量", () => {
	// 收纳条的 N = 活跃数 - VISIBLE_TOAST_COUNT；若 sonner.tsx 里 visibleToasts
	// 另行硬编码，两边一漂移收纳条就会在「其实没溢出」时出现。
	const source = readFileSync("src/renderer/src/components/ui-shadcn/sonner.tsx", "utf8");
	assert.match(source, /visibleToasts=\{VISIBLE_TOAST_COUNT\}/, "visibleToasts 必须引用共享常量");
});
