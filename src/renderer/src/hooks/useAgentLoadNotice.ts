import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import { sessionRuntimeByIdAtom } from "../atoms";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { countActivatedAgents, HIGH_AGENT_COUNT_THRESHOLD } from "../utils/agentLoadNotice";

// 本次应用运行周期内用户是否选择了「不再提醒」：纯内存态，应用重启后自动重置（即“下次重启后恢复提醒”）。
// 模块级变量而非 atom：该状态只被本 hook 消费，不需要跨组件共享，也天然满足“重启即重置”的语义。
let snoozedForLaunch = false;

/**
 * 激活 Agent 数量告警提示（人文提醒，不阻塞操作）：
 * - 由设置项 agentCountReminderEnabled 控制，关闭后本周期不再提醒；
 * - 开启时：每次应用启动后，运行时清单恢复完成（初始 listRuntimes 落库触发 atom 更新）即检查一次，
 *   若激活数量 >= 阈值就弹一次 toast；
 * - 运行期间首次把激活数量推到阈值之上（如陆续启动第 15 个 Agent）也会弹一次；
 * - 同一轮应用生命周期内最多提示一次，避免反复打扰；关闭几个 Agent 后再到阈值不再重复弹；
 * - toast 提供两个操作：点「知道了」仅关闭当前提示；点「本次不再提醒」则本启动周期内
 *   静默（内存态，应用重启后自动恢复提醒），把打扰频率的控制权交给用户。
 */
export function useAgentLoadNotice(enabled: boolean, threshold: number = HIGH_AGENT_COUNT_THRESHOLD): void {
	const store = useStore();
	// 开关经 ref 透传：设置变化不会重建订阅，check 时实时读取
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	// 阈值经 ref 透传：effect 只依赖 store，设置变化不会重建订阅
	const thresholdRef = useRef(threshold);
	thresholdRef.current = threshold;
	// 本轮生命周期是否已提示过：达到阈值后只提示一次
	const warnedRef = useRef(false);

	useEffect(() => {
		const check = () => {
			if (!enabledRef.current || snoozedForLaunch || warnedRef.current) return;
			const count = countActivatedAgents(store.get(sessionRuntimeByIdAtom));
			if (count < thresholdRef.current) return;
			warnedRef.current = true;
			showNotice(t("app.highAgentCountBody", { count }), 15000, "warning", t("app.highAgentCountTitle"), {
				// 主按钮：本启动周期内不再提示（内存态，重启后自动恢复）
				action: {
					label: t("app.highAgentCountSnooze"),
					onClick: () => {
						snoozedForLaunch = true;
					},
				},
				// 次按钮：仅关闭当前 toast，下次启动仍会检查提醒
				cancel: {
					label: t("app.projectRemoveBlockedAck"),
					onClick: () => undefined,
				},
			});
		};
		// 挂载先查一次（主进程可能已恢复运行时）；随后订阅运行时变化（启动/关闭 Agent 都会更新 atom）
		check();
		// jotai v2 Store 暴露 sub(atom, listener)，返回退订函数
		const unsubscribe = store.sub(sessionRuntimeByIdAtom, check);
		return unsubscribe;
	}, [store]);
}
