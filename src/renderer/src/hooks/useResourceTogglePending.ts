import { useCallback, useRef, useState } from "react";
import { clearTogglePending, isTogglePending, markTogglePending, resolveToggleEnabled, settleTogglePending, type PendingToggleMap } from "../config/resourceTogglePending";

/**
 * 资源开关（扩展 / 技能 / 提示词）的乐观更新状态。
 * 点开关时先 begin(key, 目标值) 让开关立刻翻转，写盘 + 刷新结束后 end(key) 清除覆盖、回落到数据真值；
 * 进行中的 key 由 ref 把关（同一行不重复发请求，避免读到渲染闭包里的旧 state），显示态走 state。
 */
export function useResourceTogglePending() {
	const [pending, setPending] = useState<PendingToggleMap>({});
	const pendingRef = useRef<Set<string>>(new Set());

	const begin = useCallback((key: string, enabled: boolean) => {
		if (pendingRef.current.has(key)) return false;
		pendingRef.current.add(key);
		setPending((prev) => markTogglePending(prev, key, enabled));
		return true;
	}, []);

	const end = useCallback((key: string) => {
		pendingRef.current.delete(key);
		setPending((prev) => clearTogglePending(prev, key));
	}, []);

	/** 数据回落后结算：行真值已等于目标值才清除覆盖（数据还没跟上时保留，避免开关弹回旧值）。 */
	const settle = useCallback((derived: Readonly<Record<string, boolean | undefined>>) => {
		setPending((prev) => settleTogglePending(prev, derived));
	}, []);

	const shown = useCallback((key: string, derivedEnabled: boolean) => resolveToggleEnabled(pending, key, derivedEnabled), [pending]);
	const isPending = useCallback((key: string) => isTogglePending(pending, key), [pending]);

	return { begin, end, settle, shown, isPending };
}
