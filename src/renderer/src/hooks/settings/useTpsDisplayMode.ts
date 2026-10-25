import { useEffect } from "react";
import { useSetAtom } from "jotai";
import type { TpsDisplayMode } from "../../../../shared/types/settings";
import { normalizeTpsDisplayMode } from "../../../../shared/tps";
import { tpsDisplayModeAtom } from "../../atoms/tps-atoms";

/** 首次读取和保存设置都同步到 atom；草稿修改不会提前影响会话指标。 */
export function useTpsDisplayMode(mode: TpsDisplayMode): void {
	const setMode = useSetAtom(tpsDisplayModeAtom);
	useEffect(() => {
		setMode(normalizeTpsDisplayMode(mode));
	}, [mode, setMode]);
}
