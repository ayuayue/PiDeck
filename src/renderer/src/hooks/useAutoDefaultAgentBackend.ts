import { useEffect, useRef } from "react";
import type { AppSettings } from "../../../shared/types";
import { resolveAutoAgentBackend, type DshRuntimeState } from "../../../shared/types/dshRuntime";
import type { PiDesktopApi } from "../../../preload";

/**
 * 默认后端的自动选择（设置项 defaultAgentBackend）。
 *
 * 产品口径（用户要求）：没有手动选过后端时，只装了 DSH runtime 而没装 pi → dsh；
 * 只有 pi / 两者都有 / 都没有 → pi。用户一旦在设置页选过，`defaultAgentBackendManual`
 * 置 true，这里不再改写——自动逻辑只负责「新用户不装 pi 也能直接用」，不替用户做决定。
 *
 * 为什么放在渲染层：判据是 pi 环境检测与 DSH runtime 探测两条现成状态，都在渲染层汇总
 * （piStatus 来自 usePiUpdate，dshState 来自 dshRuntimeStatusAtom）。主进程启动时
 * 只有持久化缓存可用，会把「刚手动装好 pi、还没检测」的用户写错。
 */
export function useAutoDefaultAgentBackend(input: {
	api: PiDesktopApi;
	settings: AppSettings;
	setSettings: (next: AppSettings) => void;
	/** DSH runtime 安装态；checking 表示还没探测完，此时不动设置。 */
	dshState: DshRuntimeState;
	/** pi 是否可用：实时检测结果优先，回落到持久化缓存。 */
	piInstalled: boolean;
}): void {
	const { api, settings, setSettings, dshState, piInstalled } = input;
	// 一次写入在途时不再排第二次：settings 回写前的重渲染会再触发 effect。
	const applyingRef = useRef(false);

	useEffect(() => {
		if (applyingRef.current) return;
		if (settings.defaultAgentBackendManual === true) return;
		// 探测未决时先不动：启动首帧 dshState=checking，写 pi 会盖掉「只装 dsh」。
		if (dshState === "checking") return;
		const current = settings.defaultAgentBackend;
		// 自动选择只管 pi/dsh；imagegen/acp 这类显式选择原样保留。
		if (current !== "pi" && current !== "dsh") return;
		const desired = resolveAutoAgentBackend({ piInstalled, dshState });
		if (desired === current) return;
		applyingRef.current = true;
		void (async () => {
			try {
				setSettings(await api.settings.update({ defaultAgentBackend: desired }));
			} catch {
				// 写盘失败只是这次没切过去：下次启动会重新判定，不打断界面
			} finally {
				applyingRef.current = false;
			}
		})();
	}, [api, settings.defaultAgentBackend, settings.defaultAgentBackendManual, setSettings, dshState, piInstalled]);
}
