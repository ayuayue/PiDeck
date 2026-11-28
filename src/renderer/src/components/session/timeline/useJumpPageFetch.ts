/**
 * 跳转的一次取页（hook）：把「入口给的 entryId」换成「含目标的那一页」塞进历史前缀，
 * 不再逐页逼近。
 *
 * 为什么需要：跳转入口拿到的是文件条目 id（会话内查找、刻度命中），而旧路径第一步就把它
 * 换成 messageId 去已加载列表里找 —— 目标没加载时必然 -1，于是只能「补一页、看看在不在、
 * 不在再补」。跳得越远补得越多，用户看到的是「一直在加载」「都要点很多次」。
 * The main-process page reader includes the target entry in this one bounded read.
 *
 * 三条防呆，都是「别让它自己转起来」：
 * 1. 只取一次（pageFetched）：取回来还是没有，说明目标不在这一页之前，继续取是空转；
 * 2. 先落标记再发请求：effect 重跑时不会再打出第二串 IPC；
 * 3. 失败吞掉不重试也不弹窗：抛出会让 pendingJump effect 在错误边界里反复重跑。
 *    错误行由 loadMoreMessages 那条路径负责。
 *
 * 切会话后到达的页作废：ownerKey 变了就丢掉，不污染新会话的历史前缀。
 *
 * 依赖方向（本文件最容易被改坏的地方）：本 hook 位于 controller 的依赖链上，
 * 任何新增 import 都会被渲染层单测的沙箱解析一次。沙箱的 require 基准是 tests/ 目录，
 * 解析不到的模块会让整片测试倒掉（2026-11 为这一条返工三次：hook 取 atoms 的常量、
 * atoms 反向 import components、两层都 import 新的 shared 文件）。所以上限常量不 import，
 * 由 controller 注入。
 */
import type { Dispatch, SetStateAction } from "react";
import type { SessionMessagePage } from "../../../../../shared/types";
import { JUMP_PAGE_TURN_SIZE } from "./historyPagePolicy";
import { planJumpPageRequest } from "./jumpWindowPolicy";
import type { TaggedTimelineJumpRequest } from "../../../hooks/session/timeline/useTimelineJumpNavigation";

/**
 * 把「跳转入参」换成主进程认的 entryId。
 *
 * 那个入参混装两种 id：
 * ① 入口侧（刻度点击、会话内查找命中未加载条目）给的是文件 entryId，原样可用；
 * ② 目录/大纲侧给的是投影消息 id，形状是 agentId + "-history-" + entryId。
 * 主进程 readRecordMessagePage 的 beforeEntryId 只认 ①。把 ② 直接传进去，锚点找不到、
 * 数值游标也没有，页面回空并标成「没有更早历史」——用户看到「点了说没有更早历史」，
 * 比原来的「连点几次」更糟，而且不报错。所以这一步必须有。
 */
export function jumpEntryIdOf(id: string): string {
	const marker = "-history-";
	const at = id.indexOf(marker);
	return at >= 0 ? id.slice(at + marker.length) : id;
}

export interface JumpPageFetchPorts {
	/** 当前会话 id；切会话后为 undefined，此时不取页。 */
	sessionId: string | undefined;
	/** 历史前缀的版本号（缓存条目的 revision）；没有缓存时传 0，prepend 会自己拒。 */
	revision: number | undefined;
	readRecordMessagePage: (sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string; includeBeforeEntry?: boolean }) => Promise<SessionMessagePage>;
	prependHistoryPage: (input: { sessionId: string; expectedRevision: number; before?: number | null; page: SessionMessagePage }) => boolean;
	/**
	 * 清掉该会话的历史前缀。只在 prepend 被拒后调用一次。
	 *
	 * 为什么需要：prependSessionHistoryPageAtom 的守卫是「新页游标必须接上前缀游标」
	 * （current.history.nextBefore !== input.before → 拒）。一次取页传 before: undefined，
	 * 所以只要用户之前翻过页（history 存在），这次 prepend 必被拒——页白读 13-26MB，
	 * 目标仍不在数据里，最后报「未能跳转」。旧前缀对「跳到别处」本来也没用，清掉是对的。
	 */
	clearHistory: (sessionId: string) => boolean;
	/** 历史前缀条数上限，由 controller 注入（唯一真值在 session-history-atoms）。见文件头「依赖方向」。 */
	historyPrefixMessageLimit: number;
	setPendingJump: Dispatch<SetStateAction<TaggedTimelineJumpRequest | undefined>>;
}

/**
 * 返回一个「试一次取页」的函数：真发起了返回 true（调用方就此 return，等数据到达后 effect 重跑），
 * 否则返回 false（继续走扩窗与放弃）。
 */
export function useJumpPageFetch(ports: JumpPageFetchPorts) {
	return (pendingJump: TaggedTimelineJumpRequest, currentOwnerKey: string, targetInLoadedData: boolean): boolean => {
		const { sessionId, revision, readRecordMessagePage, prependHistoryPage, clearHistory, setPendingJump, historyPrefixMessageLimit } = ports;
		if (!sessionId || pendingJump.value.pageFetched) return false;
		// 目标已在已加载数据里就不取页：点在屏幕上的消息是最常见的情况，此时取页只是白读
		// 13-26MB（200 轮），还会把这 200 轮塞进历史前缀，改变用户回到顶部时看到的东西。
		if (targetInLoadedData) return false;
		const plan = planJumpPageRequest({
			entryId: jumpEntryIdOf(pendingJump.value.messageId),
			pageFetched: false,
			expandAttempts: pendingJump.value.expandAttempts,
		});
		if (plan.kind !== "fetch-page") return false;
		const requestOwnerKey = pendingJump.ownerKey;
		// 先落标记再发请求：无论成功失败都只发一次。
		setPendingJump({ ownerKey: requestOwnerKey, value: { ...pendingJump.value, pageFetched: true, nonce: pendingJump.value.nonce + 1 } });
		void readRecordMessagePage(sessionId, undefined, JUMP_PAGE_TURN_SIZE, { beforeEntryId: plan.beforeEntryId, includeBeforeEntry: true })
			.then((page) => {
				if (currentOwnerKey !== requestOwnerKey) return;
				// 撑爆前缀上限时别 prepend：prependSessionHistoryPageAtom 会把整页丢掉并把游标置成
				// 「没有更早历史」，用户看到的是「这条根本没有历史」——比原来的「连点几次」更糟，
				// 而且是撒谎（历史在盘上，只是这页太大）。这时宁可不取这页，退回扩窗与放弃，
				// 由 resolveJumpPendingAction 给出如实的失败提示。
				if (page.messages.length >= historyPrefixMessageLimit) return;
				const prepend = { sessionId, expectedRevision: revision ?? 0, before: undefined, page };
				// 第一次可能被「游标接不上」的守卫拒掉（用户翻过页时必然如此）：清掉旧前缀再试一次。
				if (!prependHistoryPage(prepend)) {
					clearHistory(sessionId);
					prependHistoryPage(prepend);
				}
			})
			.catch(() => {
				// 见文件头第 3 条：吞掉是承重设计。
			});
		return true;
	};
}
