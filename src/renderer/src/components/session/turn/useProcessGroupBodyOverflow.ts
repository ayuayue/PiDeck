import { useEffect, useState } from "react";
import type { MessageScrollerGeometry } from "../../agents/message-scroller-context";

/**
 * 组体限高视口的「还能往哪个方向滚」。
 *
 * 隐藏滚动条之后，组体被裁断的那一侧没有任何线索——长组里用户不知道上面还有内容、
 * 也不知道已经到底。这里只回答两个布尔量，由组体在左侧竖线上画两条渐隐提示
 * （不写文字、不加计数、不占高度）。
 *
 * 复用组体已有的几何订阅（`useProcessGroupScrollGeometry`：一条 scroll 监听 +
 * 一份尺寸观察 + 一帧调度），不为这条提示另建监听。
 */
export type ProcessGroupBodyOverflow = { up: boolean; down: boolean };

const NO_OVERFLOW: ProcessGroupBodyOverflow = Object.freeze({ up: false, down: false });

/** 亚像素容差：边缘会留不到 1px 的余量（125%/150% 缩放同理）。 */
const EDGE_TOLERANCE_PX = 1;

export function useProcessGroupBodyOverflow(open: boolean, controls: MessageScrollerGeometry): ProcessGroupBodyOverflow {
	const [overflow, setOverflow] = useState<ProcessGroupBodyOverflow>(NO_OVERFLOW);

	useEffect(() => {
		if (!open) {
			setOverflow((previous) => (previous === NO_OVERFLOW ? previous : NO_OVERFLOW));
			return;
		}
		const measure = () => {
			const scroll = controls.scrollRef.current;
			if (!scroll) return;
			const up = scroll.scrollTop > EDGE_TOLERANCE_PX;
			const down = scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - EDGE_TOLERANCE_PX;
			// 值没变就返回原对象：滚动每帧都会走到这里，不能每次都触发重渲染。
			setOverflow((previous) => (previous.up === up && previous.down === down ? previous : { up, down }));
		};
		measure();
		return controls.subscribeGeometry(measure);
	}, [open, controls]);

	return overflow;
}
