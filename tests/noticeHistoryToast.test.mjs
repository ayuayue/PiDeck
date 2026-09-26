import { it } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * toast 通知历史 + 全局统一展示时长的行为断言。
 * 背景：扩展 ctx.ui.notify 的提示硬编码 1500ms「烧一下就没了」，且错过后无从回看。
 * showNotice 是全渲染层唯一入口，这里从它断言两件事：
 * 1. 每次弹出都进 noticeHistory 环形缓冲（封顶丢最旧、订阅可退订、可清空）；
 * 2. 时长口径是「全局统一」：设置项覆盖调用方显式传入的时长与各档内部默认，
 *    唯一保留的是常驻（Number.POSITIVE_INFINITY）。
 */
function loadNotice(noticeHistory) {
	const sonnerCalls = [];
	const notice = createTsSandbox({
		stubs: {
			react: { createElement: (component, props) => ({ component, props }) },
			sonner: {
				toast: {
					custom: (render, options) => sonnerCalls.push({ render, options }),
					dismiss: (id) => sonnerCalls.push({ dismissed: id }),
				},
			},
			// 卡片与 i18n/clipboard 不是本测试的关注点，截断依赖图（notice-toast 会再引 lucide/react）
			"../components/ui-shadcn/notice-toast": { NoticeToastCard: () => null },
			"../i18n": { t: (key) => key },
			"./clipboard": { writeClipboard: async () => true },
			"./noticeHistory": noticeHistory,
		},
		globals: { document: undefined, window: undefined, CSS: { escape: (v) => v } },
	})("src/renderer/src/utils/notice.ts");
	return { notice, sonnerCalls };
}

it("时长口径为全局统一：设置档覆盖各档默认与调用方显式时长，仅常驻保留", () => {
	const recorded = [];
	const { notice } = loadNotice({ recordNoticeHistory: (entry) => recorded.push(entry) });
	notice.setToasterReady(true);

	notice.configureNoticeDefaults({ toastDurationMs: 8000 });
	notice.showNotice("扩展提示", undefined, "info");
	assert.equal(recorded[0].duration, 8000, "info 未传时长应采用配置档");

	notice.showNotice("异常提示", undefined, "error");
	notice.showNotice("警示提示", undefined, "warning");
	notice.showNotice("提问提示", undefined, "question");
	assert.deepEqual(
		recorded.slice(1).map((entry) => entry.duration),
		[8000, 8000, 8000],
		"error/warning/question 也统一走配置档（原 3000ms 内部默认已被覆盖）",
	);

	notice.showNotice("短确认", 1200);
	notice.showNotice("长错误", 10000, "error");
	assert.deepEqual(
		recorded.slice(4).map((entry) => entry.duration),
		[8000, 8000],
		"调用方显式时长一律被配置档覆盖",
	);

	// 常驻是唯一保留项
	notice.showNotice("必须手动关闭", Number.POSITIVE_INFINITY, "error");
	assert.equal(recorded[6].duration, Number.POSITIVE_INFINITY, "显式常驻不受配置牵引");

	// 常驻哨兵：配置档本身变成 Infinity
	notice.configureNoticeDefaults({ toastDurationMs: -1 });
	notice.showNotice("扩展提示2", undefined, "info");
	assert.equal(recorded[7].duration, Number.POSITIVE_INFINITY);
});

it("configureNoticeDefaults 只接受正数与常驻哨兵（-1 → Infinity），脏值忽略", () => {
	const { notice } = loadNotice({ recordNoticeHistory: () => undefined });
	const initial = notice.getNoticeDefaultDurationMs();

	notice.configureNoticeDefaults({ toastDurationMs: "6000" });
	notice.configureNoticeDefaults({ toastDurationMs: 0 });
	notice.configureNoticeDefaults({ toastDurationMs: -5 });
	notice.configureNoticeDefaults({ toastDurationMs: Number.NaN });
	assert.equal(notice.getNoticeDefaultDurationMs(), initial, "非法值不应改变默认档");

	notice.configureNoticeDefaults({ toastDurationMs: -1 });
	assert.equal(notice.getNoticeDefaultDurationMs(), Number.POSITIVE_INFINITY, "哨兵 -1 应映射为常驻");

	notice.configureNoticeDefaults({ toastDurationMs: 2500 });
	assert.equal(notice.getNoticeDefaultDurationMs(), 2500);
});

it("showNotice 把每次弹出写进历史：kind/标题/正文/生效时长", () => {
	const recorded = [];
	const { notice } = loadNotice({ recordNoticeHistory: (entry) => recorded.push(entry) });
	notice.setToasterReady(true);
	notice.configureNoticeDefaults({ toastDurationMs: 6000 });

	notice.showNotice("路径不存在", undefined, "warning", "打开文件失败");
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0].title, "打开文件失败");
	assert.equal(recorded[0].description, "路径不存在");
	assert.equal(recorded[0].kind, "warning");
	// 生效时长即全局配置档
	assert.equal(recorded[0].duration, 6000);

	notice.showNotice("只有正文", 1234);
	assert.equal(recorded[1].title, "只有正文");
	assert.equal(recorded[1].description, undefined);
	assert.equal(recorded[1].kind, "neutral");
	assert.equal(recorded[1].duration, 6000, "记录的是生效时长（全局档），不是调用方传入值");

	// 空正文被丢弃：也不该留历史
	notice.showNotice("   ");
	assert.equal(recorded.length, 2);
});

it("历史环形缓冲封顶丢最旧、快照引用稳定、订阅可退订、可清空", () => {
	const { recordNoticeHistory, getNoticeHistorySnapshot, subscribeNoticeHistory, clearNoticeHistory, NOTICE_HISTORY_MAX_ENTRIES } = createTsSandbox()("src/renderer/src/utils/noticeHistory.ts");

	let notified = 0;
	const unsubscribe = subscribeNoticeHistory(() => {
		notified += 1;
	});
	assert.equal(getNoticeHistorySnapshot().length, 0);
	const emptySnapshot = getNoticeHistorySnapshot();

	for (let i = 0; i < NOTICE_HISTORY_MAX_ENTRIES + 20; i += 1) {
		recordNoticeHistory({ title: `n${i}`, kind: "info", duration: 1000 });
	}
	const entries = getNoticeHistorySnapshot();
	assert.equal(entries.length, NOTICE_HISTORY_MAX_ENTRIES, "超出上限应封顶");
	assert.equal(entries[0].title, `n20`, "应丢弃最旧的 20 条");
	assert.equal(entries[entries.length - 1].title, `n${NOTICE_HISTORY_MAX_ENTRIES + 19}`);
	assert.equal(getNoticeHistorySnapshot(), entries, "未变更时快照引用必须稳定（useSyncExternalStore 前提）");
	assert.ok(getNoticeHistorySnapshot() !== emptySnapshot);
	assert.equal(notified, NOTICE_HISTORY_MAX_ENTRIES + 20, "每次记录都应通知订阅者");

	unsubscribe();
	clearNoticeHistory();
	assert.equal(getNoticeHistorySnapshot().length, 0);
	assert.equal(notified, NOTICE_HISTORY_MAX_ENTRIES + 20, "退订后不再收到通知");
});

it("历史表格筛选：最新在前，级别精确匹配、关键词命中标题或详情（忽略大小写与空白）", () => {
	const { filterNoticeHistory } = createTsSandbox()("src/renderer/src/utils/noticeHistory.ts");
	const rows = [
		{ id: 1, timestamp: 1, kind: "info", title: "扩展已加载", duration: 1000 },
		{ id: 2, timestamp: 2, kind: "warning", title: "Rate Limit", description: "sleep 30s then retry", duration: 2000 },
		{ id: 3, timestamp: 3, kind: "error", title: "发送失败", description: "Rate limit exceeded", duration: 3000 },
	];
	// 结果在沙箱 realm 里构造，取 id 回到宿主 realm 再比较（deepStrictEqual 会比原型）
	const ids = (filter) => Array.from(filterNoticeHistory(rows, filter), (entry) => entry.id);

	assert.deepEqual(ids({ search: "", kind: "all" }), [3, 2, 1], "无筛选应返回全部且最新在前");
	assert.deepEqual(ids({ search: "", kind: "warning" }), [2], "级别筛选应精确匹配");
	assert.deepEqual(ids({ search: "rate limit", kind: "all" }), [3, 2], "关键词应忽略大小写并命中标题或详情");
	assert.deepEqual(ids({ search: "  扩展  ", kind: "all" }), [1], "关键词应忽略首尾空白");
	assert.deepEqual(ids({ search: "rate", kind: "error" }), [3], "两个条件应取交集");
	assert.deepEqual(ids({ search: "不存在", kind: "all" }), [], "无命中返回空数组");
});

it("重放历史条目还原 kind/标题/正文，时长沿用当前全局档（常驻条目仍常驻）", () => {
	const recorded = [];
	const { notice, sonnerCalls } = loadNotice({ recordNoticeHistory: (entry) => recorded.push(entry) });
	notice.setToasterReady(true);
	notice.configureNoticeDefaults({ toastDurationMs: 7000 });
	notice.showNotice("正文详情", 5000, "error", "会话失败");
	notice.showNotice("需要手动处理", Number.POSITIVE_INFINITY, "error", "会话中断");
	sonnerCalls.length = 0;

	notice.replayNoticeEntry(recorded[0]);
	notice.replayNoticeEntry(recorded[1]);
	assert.equal(sonnerCalls.length, 2);
	const card = sonnerCalls[0].render("toast-id");
	assert.equal(card.props.title, "会话失败");
	assert.equal(card.props.description, "正文详情");
	assert.equal(card.props.kind, "error");
	// 重放不还原当初的显式时长：时长归当前配置档管（与全局统一口径一致）
	assert.equal(sonnerCalls[0].options.duration, 7000);
	assert.equal(sonnerCalls[1].options.duration, Number.POSITIVE_INFINITY, "常驻条目重放后仍常驻");
});
