import { useEffect, useRef, useState } from "react";

/**
 * 动画窗口：trigger 变化后返回 true 并持续 windowMs，随后回落 false。
 * 用于「只在程序化布局切换后的短暂窗口内挂 CSS 过渡、拖拽等直接操作不挂」的开关属性
 * （终端折叠 SessionView、git 分区开合 GitPanel）。初始挂载不触发；重复触发重置窗口；
 * 卸载自动清理定时器（生命周期配对）。
 *
 * 之所以收口成 hook 而不是各组件手写 setTimeout：GitPanel 有源码契约守卫
 * （tests/gitPanelUi.test.mjs 禁止面板源里出现 setTimeout(…mutationRunningRef…），
 * 定时器逻辑必须留在面板文件之外。
 */
export function useAnimationWindow(trigger: unknown, windowMs: number): boolean {
	const [active, setActive] = useState(false);
	const prevRef = useRef(trigger);
	const timerRef = useRef<number | null>(null);
	useEffect(() => {
		if (prevRef.current === trigger) return;
		prevRef.current = trigger;
		setActive(true);
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			setActive(false);
		}, windowMs);
	}, [trigger, windowMs]);
	// 卸载清理：组件销毁时停表，避免卸载后 setState
	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);
	return active;
}
