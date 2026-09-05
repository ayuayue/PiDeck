import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStepsVisibleMemoryEntry } from "../../../atoms/session-atoms";

export type TurnExecutionState = {
	/** 思考/工具/中间回答步骤是否可见（run 级唯一折叠开关）。 */
	stepsVisible: boolean;
	/** 用户意图：设为指定开合态（勿用「toggle + Radix onOpenChange」以免连点/回调把状态打反）。 */
	setStepsVisibleFromUser: (open: boolean) => void;
	toggleSteps: () => void;
};

/**
 * run 级执行过程折叠状态（一个开关控制全部思考/工具/中间回答步骤）。
 *
 * 行为：
 * - 记忆优先（stepsVisibleMemory，run 级跨挂载）：手动/流式展开过的轮次
 *   切会话再切回时恢复原样；无记忆才走初始态。记忆带写入时的新一轮 tick
 *   （atTick）：新一轮只压过“早于该轮”的旧记忆，新一轮之后用户再次手动
 *   展开写下的记忆（atTick >= 当前 tick）必须恢复——否则每次都折叠；
 * - 非 live（只看历史/会话空闲）挂载时一律折叠：已完成轮只留最终回答；
 *   无最终回答的中断轮（stop/steer 打断）同样收起（旧实现把设置①误用于
 *   静止历史，导致只看历史时中断轮整段展开）；
 * - 新一轮已发生且本轮非最新：挂载即折叠，旧记忆作废（规则④优先）；
 * - 手动开合永远最高优先：流式上升沿不会覆盖用户已折叠的状态；
 * - 流式上升沿：设置①（expandInterimDuringStream）开启且无手动 override 时展开；
 * - 新一轮信号：非最新轮强制收起（含手动展开的），节省渲染资源；
 * - 自动收起信号：最新轮结束且用户 1.5s 无操作后，timeline 发来 autoCollapseTick；
 *   若执行过程仍打开，则收起并回调 onAutoCollapsed，由 timeline 把本轮起始消息
 *   拉到视口中上方。这样「结束即展开」的旧行为被替换为「先复盘，再安静收起」。
 */
export function useTurnExecution(opts: {
	runId?: string;
	agentRunning?: boolean;
	isComplete: boolean;
	/** 本轮是否存在最终回答：决定自动收起行为——无最终回答的 run 不自动收起
	 * （中间回答是唯一输出，避免折叠后整轮只剩空壳），但新一轮信号仍会强制收起。 */
	hasFinalAnswer?: boolean;
	/** 是否时间线上最新一轮。非最新轮不自动展开/收起。 */
	isLatestRun?: boolean;
	/** 设置①：流式对话时展开中间过程。默认关。 */
	expandInterimDuringStream?: boolean;
	/** 设置②：新一轮开始时收起上一轮。默认开。 */
	collapsePrevRunsOnNewTurn?: boolean;
	/** 新一轮开始信号（session 级单调递增）。变化时非最新轮被强制收起。 */
	newTurnCollapseTick?: number;
	/** 最新轮结束后的自动收起信号（timeline 侧 1.5s idle 计时）。 */
	autoCollapseTick?: number;
	/** 自动收起真正发生后回调（timeline 据此做「拉到中上方」定位）。 */
	onAutoCollapsed?: () => void;
	/** 跨挂载记忆的当前值（undefined = 无记忆，走初始态规则）。 */
	stepsVisibleMemory?: RunStepsVisibleMemoryEntry;
	/** 记忆变更回调：{ visible, atTick } = 记录展开意愿与当时的新一轮 tick；
	 * undefined = 清除（系统收起/新一轮折叠时）。 */
	onStepsVisibleMemoryChange?: (visible: boolean | undefined, atTick: number) => void;
}): TurnExecutionState {
	const [stepsVisible, setStepsVisible] = useState(() => {
		const currentTick = opts.newTurnCollapseTick ?? 0;
		const memory = opts.stepsVisibleMemory;
		// 记忆带 tick 版本（2026 用户反馈）：只恢复「记忆写入晚于等于当前新一轮」
		// 的展开意愿——用户在新一轮之后再次手动展开是明确的最新意愿；
		// 早于最新一轮的旧记忆由新一轮规则压过（下方），不许“永久压过新意向”。
		if (memory !== undefined && memory.atTick >= currentTick) {
			return memory.visible;
		}
		// 新一轮已发生且本轮非最新：一律折叠（含手动展开过的，含本轮刚刚失去
		// 最新位 & tick 已 bump 的「卸载期间新消息」场景），旧记忆作废。
		if (
			opts.collapsePrevRunsOnNewTurn !== false &&
			opts.isLatestRun === false &&
			currentTick > 0
		) {
			return false;
		}
		// 非 live（agentRunning=false：只看历史/会话空闲）一律折叠。
		// 历史已完成、有最终回答的轮自然折叠；无最终回答的中断轮（stop/steer
		// 打断，中间回答是其唯一输出）也不例外——只读历史时默认收起，
		// 而不是把设置①（流式展开）误用于静止的历史轮次。
		if (!opts.agentRunning) return false;
		// 仅 live 流式轮遵循设置①：流式中展开中间过程，结束后由
		// 自动收起信号 / 新一轮信号收掉。
		return Boolean(opts.expandInterimDuringStream);
	});
	const userOverrideRef = useRef(false);
	const wasRunningRef = useRef(Boolean(opts.agentRunning));
	const stepsVisibleRef = useRef(stepsVisible);
	// 挂载即把当前 autoCollapseTick 视为已消费：tick 是 timeline 侧单调递增，
	// TurnRow 以 run.id 重挂载（切会话再切回）时收到的是旧值，不能重新触发
	// 收起——否则记忆恢复的展开会在挂载瞬间又被 1.5s 收掉（2026 用户反馈）。
	const lastAutoCollapseTickRef = useRef(opts.autoCollapseTick ?? 0);
	// 新一轮折叠信号同理：只在“挂载后新发生的轮次”时执行，挂载即消费当前值。
	// 否则切回时刚恢复的记忆（atTick == 当前 tick）会在 effect 首跑时被再次清空。
	const lastNewTurnCollapseTickRef = useRef(opts.newTurnCollapseTick ?? 0);
	const lastRunIdRef = useRef(opts.runId);

	useEffect(() => {
		stepsVisibleRef.current = stepsVisible;
	}, [stepsVisible]);

	useEffect(() => {
		if (lastRunIdRef.current === opts.runId) return;
		lastRunIdRef.current = opts.runId;
		// run 切换（实例复用）：同样把当前 tick 视为已消费，避免旧信号重放。
		lastAutoCollapseTickRef.current = opts.autoCollapseTick ?? 0;
		lastNewTurnCollapseTickRef.current = opts.newTurnCollapseTick ?? 0;
	}, [opts.runId, opts.autoCollapseTick, opts.newTurnCollapseTick]);

	// 流式上升沿展开。只处理「开始跑」这一个边沿，busy 抖动不会把用户手动折叠的
	// 轮次重新撑开；下降沿不再自动展开（旧「结束展开」已由 1.5s 自动收起取代）。
	useEffect(() => {
		const running = Boolean(opts.agentRunning);
		if (
			running &&
			!wasRunningRef.current &&
			!userOverrideRef.current &&
			opts.expandInterimDuringStream
		) {
			setStepsVisible(true);
			opts.onStepsVisibleMemoryChange?.(true, opts.newTurnCollapseTick ?? 0);
		}
		wasRunningRef.current = running;
	}, [opts.agentRunning, opts.expandInterimDuringStream, opts.onStepsVisibleMemoryChange]);

	// 新一轮信号：非最新轮强制收起（含手动展开的——本轮已结束，新消息发出后收掉）。
	// 收起同时清除记忆：收掉后的轮切回仍保持折叠；用户再次手动展开时重新写记忆。
	// 消费式处理：仅在“挂载后新发生的新一轮”时动作，挂载时已有的 tick 由初始态
	// 裁定（记忆 atTick >= tick 时恢复，否则按新一轮折叠），effect 不重复清空。
	useEffect(() => {
		if (!opts.collapsePrevRunsOnNewTurn) return;
		const tick = opts.newTurnCollapseTick ?? 0;
		if (tick <= 0 || tick === lastNewTurnCollapseTickRef.current) return;
		// tick 已推进但本轮仍是最新（新一轮属于本轮的后续渲染）：等 isLatestRun
		// 翻转后再消费，避免新 tick 被吞掉导致“最新轮失去最新位后不再折叠”。
		if (opts.isLatestRun !== false) return;
		lastNewTurnCollapseTickRef.current = tick;
		userOverrideRef.current = false;
		setStepsVisible(false);
		opts.onStepsVisibleMemoryChange?.(undefined, tick);
	}, [
		opts.collapsePrevRunsOnNewTurn,
		opts.isLatestRun,
		opts.newTurnCollapseTick,
		opts.onStepsVisibleMemoryChange,
	]);

	// timeline 侧 1.5s idle 后发来的自动收起信号。仅最新轮、仍有最终回答且执行过程
	// 当前可见时收起；已经手动折叠/从未展开的轮次不回调，timeline 不会错误滚动。
	// 收起同样清除记忆：下次挂载回到初始态（历史轮折叠）。
	useEffect(() => {
		const tick = opts.autoCollapseTick ?? 0;
		if (tick <= 0 || tick === lastAutoCollapseTickRef.current) return;
		lastAutoCollapseTickRef.current = tick;
		if (opts.isLatestRun === false || !opts.hasFinalAnswer) return;
		if (!stepsVisibleRef.current) return;
		userOverrideRef.current = false;
		setStepsVisible(false);
		opts.onStepsVisibleMemoryChange?.(undefined, tick);
		opts.onAutoCollapsed?.();
	}, [
		opts.autoCollapseTick,
		opts.hasFinalAnswer,
		opts.isLatestRun,
		opts.onAutoCollapsed,
		opts.onStepsVisibleMemoryChange,
	]);

	const setStepsVisibleFromUser = useCallback((open: boolean) => {
		userOverrideRef.current = true;
		setStepsVisible(open);
		opts.onStepsVisibleMemoryChange?.(open, opts.newTurnCollapseTick ?? 0);
	}, [opts.onStepsVisibleMemoryChange, opts.newTurnCollapseTick]);

	const toggleSteps = useCallback(() => {
		userOverrideRef.current = true;
		setStepsVisible((prev) => {
			const next = !prev;
			opts.onStepsVisibleMemoryChange?.(next, opts.newTurnCollapseTick ?? 0);
			return next;
		});
	}, [opts.onStepsVisibleMemoryChange, opts.newTurnCollapseTick]);

	return { stepsVisible, setStepsVisibleFromUser, toggleSteps };
}
