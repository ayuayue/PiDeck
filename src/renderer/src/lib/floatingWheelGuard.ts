/**
 * 浮层滚轮隔离：让 portal 到 body 的浮层（Radix Select / Popover / DropdownMenu 内容、
 * 自研 portal 面板）在 Radix Dialog 打开时滚轮仍然可用。
 *
 * 为什么需要：Radix Dialog 的滚动锁（react-remove-scroll）会在 document 上注册 wheel 监听
 * （SideEffect#shouldPrevent），凡是「不在锁定节点（dialog content）/shards 之内」的事件一律
 * preventDefault——而 portal 到 body 的浮层恰恰是这种结构，于是浮层自身的 overflow-y-auto
 * 永远接不到滚轮滚动（表现为「值多的时候下拉滚不动」）。
 *
 * 做法：在浮层根节点用 capture 阶段 stopPropagation，事件不再冒泡到 document，滚动锁的
 * wheel 监听听不到它；stopPropagation 不阻止默认动作，浏览器仍会对 target 的最近可滚动
 * 祖先（浮层自身）执行滚动。
 *
 * 幂等性：同一节点重复 attach 返回同一 cleanup（React ref 回调每次渲染都会重新触发，
 * 不能反复 add/remove 造成事件抖动）。
 */
const guards = new WeakMap<Element, () => void>();

export function attachFloatingWheelGuard(root: Element): () => void {
	const existing = guards.get(root);
	if (existing) return existing;
	const onWheelCapture = (event: Event) => {
		event.stopPropagation();
	};
	root.addEventListener("wheel", onWheelCapture, { capture: true });
	const cleanup = () => {
		root.removeEventListener("wheel", onWheelCapture, { capture: true });
		guards.delete(root);
	};
	guards.set(root, cleanup);
	return cleanup;
}

/**
 * React 19 ref 回调版本：返回 cleanup，卸载时由 React 调用（不再以 null 重调用）。
 * 模块级稳定引用，避免内联箭头函数导致每次渲染重复 detach/attach。
 */
export function floatingWheelGuardRef(node: HTMLElement | null): (() => void) | undefined {
	if (!node) return;
	return attachFloatingWheelGuard(node);
}
