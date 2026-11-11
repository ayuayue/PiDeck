import { useCallback, useMemo } from "react";
import type { PiConfigTarget, PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { resourceTargetOptions, resourceWriteAllowed, type PiResourceWriteAction } from "./piResourceTargetModel";
import type { ResourceScope } from "./resourceScopeModel";

/**
 * 资源三页（技能/提示词/扩展）的目标视图与门禁。
 *
 * 目标不再是本页自己的 state：它跟随顶层的 Pi 环境（本机 / WSL 发行版；ssh 环境不提供资源页）。
 * 双选择器是上一版的真实问题——配置页选了 A 发行版、资源页还停在 B，两个写作用域同时存在。
 * 因此这里只做「派生 + 门禁」，不提供 setter。
 */
export function useResourceTarget(resourceScope: ResourceScope, target: PiConfigTarget) {
	const resourceTarget = useMemo<PiResourceTarget>(() => (target.kind === "wsl" ? { kind: "wsl", hostId: target.hostId } : { kind: "local" }), [target]);
	const global = resourceScope === "global";
	const options = useMemo<PiResourceOptions | undefined>(() => (global ? resourceTargetOptions(resourceTarget) : undefined), [global, resourceTarget]);
	/** true = 该动作在当前目标下已拦下并提示（调用方直接 return）；false = 放行。 */
	const blockMutation = useCallback(
		(action: PiResourceWriteAction) => {
			if (!global) return false;
			if (resourceWriteAllowed(action, resourceTarget)) return false;
			showNotice(t("config.resourceTarget.writeUnsupported"), 5000, "warning");
			return true;
		},
		[global, resourceTarget],
	);
	return { resourceTarget, options, blockMutation };
}

export type ResourceTargetView = ReturnType<typeof useResourceTarget>;
