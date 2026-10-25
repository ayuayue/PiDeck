/*!---------------------------------------------------------------------------------------------
 *  Copyright (c) StackBlitz. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * use-stick-to-bottom（MIT，StackBlitz）移植版 — 组件层。
 *
 * 与官方 StickToBottom 组件一致：Provider 包裹 + Content 子组件（滚动容器 + 内容容器）。
 * 补全 TypeScript 类型；对外接口（StickToBottom / StickToBottom.Content / useStickToBottomContext）
 * 与官方一致，便于后续直接替换回 npm 包。
 */
import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { useStickToBottom, type GetTargetScrollTop, type ScrollToBottom, type StickToBottomInstance, type StickToBottomOptions, type StickToBottomState, type StopScroll } from "./useStickToBottom";

export interface StickToBottomContext {
	contentRef: MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
	scrollRef: MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
	scrollToBottom: ScrollToBottom;
	stopScroll: StopScroll;
	isAtBottom: boolean;
	escapedFromLock: boolean;
	get targetScrollTop(): GetTargetScrollTop | null;
	set targetScrollTop(targetScrollTop: GetTargetScrollTop | null);
	state: StickToBottomState;
}

export interface StickToBottomProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children">, StickToBottomOptions {
	contextRef?: React.Ref<StickToBottomContext>;
	instance?: StickToBottomInstance;
	children: ((context: StickToBottomContext) => ReactNode) | ReactNode;
}

const StickToBottomContextCtx = createContext<StickToBottomContext | null>(null);
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function StickToBottom({ instance, children, resize, initial, mass, damping, stiffness, targetScrollTop: currentTargetScrollTop, contextRef, ...props }: StickToBottomProps): ReactNode {
	const customTargetScrollTop = useRef<GetTargetScrollTop | null>(null);
	const targetScrollTop = useCallback(
		(target: number, elements: Parameters<GetTargetScrollTop>[1]) => {
			const get = context?.targetScrollTop ?? currentTargetScrollTop;
			return get?.(target, elements) ?? target;
		},
		[currentTargetScrollTop],
	);
	const defaultInstance = useStickToBottom({
		mass,
		damping,
		stiffness,
		resize,
		initial,
		targetScrollTop,
	});
	const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom, escapedFromLock, state } = instance ?? defaultInstance;
	const context = useMemo<StickToBottomContext>(
		() => ({
			scrollToBottom,
			stopScroll,
			scrollRef,
			isAtBottom,
			escapedFromLock,
			contentRef,
			state,
			get targetScrollTop() {
				return customTargetScrollTop.current;
			},
			set targetScrollTop(targetScrollTop: GetTargetScrollTop | null) {
				customTargetScrollTop.current = targetScrollTop;
			},
		}),
		[scrollToBottom, isAtBottom, contentRef, scrollRef, stopScroll, escapedFromLock, state],
	);
	useImperativeHandle(contextRef, () => context, [context]);
	useIsomorphicLayoutEffect(() => {
		if (!scrollRef.current) {
			return;
		}
		if (getComputedStyle(scrollRef.current).overflow === "visible") {
			scrollRef.current.style.overflow = "auto";
		}
	}, []);
	return (
		<StickToBottomContextCtx.Provider value={context}>
			<div {...props}>{typeof children === "function" ? children(context) : children}</div>
		</StickToBottomContextCtx.Provider>
	);
}

export namespace StickToBottom {
	export interface ContentProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
		children: ((context: StickToBottomContext) => ReactNode) | ReactNode;
		scrollClassName?: string;
	}
	export function Content({ children, scrollClassName, ...props }: ContentProps): ReactNode {
		const context = useStickToBottomContext();
		return (
			<div
				ref={context.scrollRef}
				style={{
					height: "100%",
					width: "100%",
					scrollbarGutter: "stable both-edges",
				}}
				className={scrollClassName}
			>
				<div {...props} ref={context.contentRef}>
					{typeof children === "function" ? children(context) : children}
				</div>
			</div>
		);
	}
}

/**
 * Use this hook inside a <StickToBottom> component to gain access to whether the component is at the bottom of the scrollable area.
 */
export function useStickToBottomContext(): StickToBottomContext {
	const context = useContext(StickToBottomContextCtx);
	if (!context) {
		throw new Error("use-stick-to-bottom component context must be used within a StickToBottom component");
	}
	return context;
}
