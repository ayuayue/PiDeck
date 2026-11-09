import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSortModeId } from "../../../../shared/types/project";
import { normalizeProjectSortMode } from "../../../../shared/projectSort";

export type ProjectSortModeOptions = {
	settingsProjectSortMode?: ProjectSortModeId;
	settingsLoaded?: boolean;
	persistProjectSortMode?: (mode: ProjectSortModeId) => void;
};

export function useProjectSortMode(options: ProjectSortModeOptions) {
	const [projectSortMode, setMode] = useState(() => normalizeProjectSortMode(options.settingsProjectSortMode));
	const hydrated = useRef(false);
	const persist = useRef(options.persistProjectSortMode);
	persist.current = options.persistProjectSortMode;
	useEffect(() => {
		if (hydrated.current || !options.settingsLoaded) return;
		hydrated.current = true;
		setMode(normalizeProjectSortMode(options.settingsProjectSortMode));
	}, [options.settingsLoaded, options.settingsProjectSortMode]);
	const setProjectSortMode = useCallback((mode: ProjectSortModeId) => {
		// 用户先操作时，迟到的初始 settings 响应不能盖掉新选择。
		hydrated.current = true;
		const next = normalizeProjectSortMode(mode);
		setMode(next);
		persist.current?.(next);
	}, []);
	return { projectSortMode, setProjectSortMode };
}
