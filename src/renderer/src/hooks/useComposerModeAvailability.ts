import { useCallback, useEffect, useState } from "react";
import type { AgentBackend, ComposerAgentMode } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

export const MODE_ORDER: ComposerAgentMode[] = ["normal", "goal", "plan"];

/**
 * 计算「+」菜单里可显示的模式（纯函数，供 hook 与单测共用，单一来源）：
 * - 生图不再是「+」菜单里的可切模式（imagegen 是独立后端，不随后端/模式切换混用）：
 *   imagegen 会话（isImageGen=true）模式菜单为空，走专用生图底栏，互不影响；
 *   而 legacy 含生图消息的 pi 会话（imageGenLocked）同样锁定为生图，不展示 LLM 模式；
 * - plan/goal 由对应内置扩展开关决定；
 */
export function computeVisibleModes(options: { isImageGen: boolean; planModeAvailable: boolean; goalModeAvailable: boolean }): ComposerAgentMode[] {
	if (options.isImageGen) return [];
	return MODE_ORDER.filter((mode) => {
		if (mode === "plan") return options.planModeAvailable;
		if (mode === "goal") return options.goalModeAvailable;
		return true;
	});
}

/**
 * 「+」菜单里的模式可用性（原 ComposerModeSelect 底栏 chip 的逻辑迁到这里）：
 * - DSH 恒可用 plan/goal。
 * - pi 的 plan/goal 由内置扩展 pi-deck-plan-mode / pi-deck-goal-mode 的启用状态决定；
 *   扩展被关时若当前正处该模式，强制回退到普通模式（与旧 chip 行为对齐）。
 * - imageGenLocked（legacy pi 会话已有生图消息）或 backend=imagegen：锁定为生图，
 *   「+」菜单不提供 LLM 模式；imagegen 会话走专用生图底栏。
 */
export function useComposerModeAvailability(props: { backend?: AgentBackend; imageGenLocked?: boolean; value: ComposerAgentMode; disabled?: boolean; onChange: (mode: ComposerAgentMode) => void }) {
	const isDsh = props.backend === "dsh";
	// ACP 无隐藏 agentMessage 通道(plan/goal 的实现载体),模式菜单只留普通;
	// pi 的扩展开关对 ACP 会话无意义,不查询。
	const isAcp = props.backend === "acp";
	const isImageGen = props.backend === "imagegen" || props.imageGenLocked === true;
	const [planModeAvailable, setPlanModeAvailable] = useState(true);
	const [goalModeAvailable, setGoalModeAvailable] = useState(true);

	const refreshAvailability = useCallback(async () => {
		if (isAcp) {
			setPlanModeAvailable(false);
			setGoalModeAvailable(false);
			return;
		}
		if (isDsh) {
			setPlanModeAvailable(true);
			setGoalModeAvailable(true);
			return;
		}
		try {
			const result = await desktopApi.extensions.list();
			const plan = result.extensions.find((extension) => extension.source === "pi-deck-plan-mode.ts");
			const goal = result.extensions.find((extension) => extension.source === "pi-deck-goal-mode.ts");
			setPlanModeAvailable(plan?.enabled !== false);
			setGoalModeAvailable(goal?.enabled !== false);
		} catch {
			// 扩展列表读取失败时保守处理：两个模式都按不可用对待，避免用户选了却无扩展响应。
			setPlanModeAvailable(false);
			setGoalModeAvailable(false);
		}
	}, [isAcp, isDsh]);

	// 打开菜单时刷新（扩展开关可能刚在设置页改过）。不可用且当前正在用则强制回退，
	// 这属于模式状态流转的边界：不在这里回退，用户会卡在一个扩展已删的模式上。
	useEffect(() => {
		if (isImageGen) return;
		if (!planModeAvailable && props.value === "plan") props.onChange("normal");
		if (!goalModeAvailable && props.value === "goal") props.onChange("normal");
	}, [goalModeAvailable, isImageGen, planModeAvailable, props.onChange, props.value]);

	const visibleModes = computeVisibleModes({
		isImageGen,
		planModeAvailable,
		goalModeAvailable,
	});

	return { visibleModes, refreshAvailability };
}
