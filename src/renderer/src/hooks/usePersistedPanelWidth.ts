import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/**
 * 渲染层面板宽度的跨来源同步：localStorage 负责首屏缓存，应用设置负责跨
 * Electron renderer origin（例如开发端口变化）恢复。宽度变化会合并后延迟写入，
 * 避免窗口缩放时 ResizeObserver 高频触发 settings IPC；页面离开时再 flush 一次。
 */
export type PersistedPanelWidthOptions = {
	width: number;
	setWidth: Dispatch<SetStateAction<number>>;
	normalize: (value: unknown) => number | null;
	loadPersistedWidth?: () => Promise<unknown>;
	persistWidth?: (width: number) => void | Promise<unknown>;
	persistDebounceMs?: number;
};

function persistSafely(persistWidth: PersistedPanelWidthOptions["persistWidth"], width: number) {
	if (!persistWidth) return;
	try {
		// settings IPC 是异步的；统一吞掉写入失败，不能让布局偏好影响主界面。
		void Promise.resolve(persistWidth(width)).catch(() => undefined);
	} catch {
		// 同步抛错（例如预览壳未提供 settings API）同样只影响持久化。
	}
}

/**
 * 将 localStorage 快照与 durable settings 对齐，并把最新宽度安全地落盘。
 * 没有 durable adapter 时保持纯 localStorage 行为，便于预览壳与单测复用。
 */
export function usePersistedPanelWidth(options: PersistedPanelWidthOptions) {
	const widthRef = useRef(options.width);
	const initialWidthRef = useRef(options.width);
	const setWidthRef = useRef(options.setWidth);
	const normalizeRef = useRef(options.normalize);
	const loadRef = useRef(options.loadPersistedWidth);
	const persistRef = useRef(options.persistWidth);
	const hydrationCompleteRef = useRef(!options.loadPersistedWidth);
	const localWidthChangedRef = useRef(false);
	const hydrationTargetRef = useRef<number | null>(null);
	const pendingWidthRef = useRef<number | null>(null);
	const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const debounceMs = options.persistDebounceMs ?? 160;

	widthRef.current = options.width;
	setWidthRef.current = options.setWidth;
	normalizeRef.current = options.normalize;
	loadRef.current = options.loadPersistedWidth;
	persistRef.current = options.persistWidth;

	function flushPendingWidth() {
		const pending = pendingWidthRef.current;
		pendingWidthRef.current = null;
		if (persistTimerRef.current !== null) {
			clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		}
		if (pending !== null) persistSafely(persistRef.current, pending);
	}

	function schedulePersist(width: number) {
		if (!persistRef.current) return;
		pendingWidthRef.current = width;
		if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
		persistTimerRef.current = setTimeout(() => {
			persistTimerRef.current = null;
			const pending = pendingWidthRef.current;
			pendingWidthRef.current = null;
			if (pending !== null) persistSafely(persistRef.current, pending);
		}, debounceMs);
	}

	// durable settings 是异步来源：加载完成前禁止用 localStorage/default 反写它，
	// 否则首屏默认值可能抢在 get() 返回前覆盖掉真正的上次宽度。
	useEffect(() => {
		const load = loadRef.current;
		if (!load) {
			hydrationCompleteRef.current = true;
			return;
		}

		let active = true;
		void Promise.resolve()
			.then(load)
			.then((raw) => {
				if (!active) return;
				const persisted = normalizeRef.current(raw);
				hydrationCompleteRef.current = true;

				if (persisted !== null && !localWidthChangedRef.current) {
					// 只有真正需要改 React state 时才设置 target；若值本来相同，
					// 必须让后续用户拖拽正常进入普通持久化路径。
					if (persisted !== widthRef.current) {
						hydrationTargetRef.current = persisted;
						setWidthRef.current((current) => {
							if (localWidthChangedRef.current) {
								hydrationTargetRef.current = null;
								return current;
							}
							return persisted;
						});
					}
					return;
				}

				// 旧版本/新 dev origin 没有 durable 值时，把当前 localStorage 快照迁移过去；
				// 如果用户在 settings 返回前已拖动，则当前交互结果优先于旧存档。
				schedulePersist(widthRef.current);
			})
			.catch(() => {
				if (active) hydrationCompleteRef.current = true;
			});

		return () => {
			active = false;
		};
	}, []);

	// 追踪 settings 尚未返回前的用户拖拽，避免异步恢复把刚刚的交互覆盖掉。
	useEffect(() => {
		if (!hydrationCompleteRef.current) {
			if (options.width !== initialWidthRef.current) localWidthChangedRef.current = true;
			return;
		}

		// durable 值刚刚应用到 React state：它已经是持久化来源，不需要再写回旧值。
		if (hydrationTargetRef.current !== null) {
			if (options.width === hydrationTargetRef.current) hydrationTargetRef.current = null;
			return;
		}
		schedulePersist(options.width);
	}, [options.width]);

	// 关闭窗口/renderer reload 可能早于 debounce timer；尽力同步最后一份宽度。
	useEffect(() => {
		if (!persistRef.current || typeof window === "undefined") return;
		const flush = () => flushPendingWidth();
		window.addEventListener("beforeunload", flush);
		window.addEventListener("pagehide", flush);
		return () => {
			window.removeEventListener("beforeunload", flush);
			window.removeEventListener("pagehide", flush);
			flushPendingWidth();
		};
	}, []);

	// 面板卸载时清理 timer；flush 已在 cleanup 中执行，避免留下悬挂资源。
	useEffect(
		() => () => {
			if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		},
		[],
	);
}
