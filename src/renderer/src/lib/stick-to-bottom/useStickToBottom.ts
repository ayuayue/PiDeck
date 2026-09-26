/*!---------------------------------------------------------------------------------------------
 *  Copyright (c) StackBlitz. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * use-stick-to-bottom（MIT，StackBlitz）移植版。
 *
 * 依赖：仅 React（无其他运行时依赖），与官方包逻辑一致，补全 TypeScript 类型。
 * 用于 AI 聊天场景"锁底跟随 + 弹簧物理 + 逃逸/锁底"的滚动引擎。
 *
 * 本地相对上游的关键改动：
 * 1. mergeAnimations 缓存 key 含 instant（上游同参污染导致 smooth/instant 串味）
 * 2. ResizeObserver 正增长且行为为 instant 时同步写 scrollTop（避免 rAF 晚一帧 paint 砰抖）
 * 3. scrollGeneration 打断在途 rAF，避免与同步校正打架
 * 4. instantResizeThreshold：大块离散增高强制 instant
 * 5. 同时观察 scroll viewport 尺寸，输入栏/相邻面板增高时继续吸底
 * 6. resizeGeneration 隔离连续同尺寸 resize 的异步清理
 * 7. 跟随态只由用户输入 / 显式命令改变；布局 scroll 与 resize 只校正几何
 * 8. 上滚逃逸累计「读者自身位移」，不把弹簧滞后 / 内容增高算进距底
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { type Animation, type SpringAnimation, mergeAnimations } from "./mergeAnimations";
import {
	decideFollowFromUserInput,
	distanceAfterWheelDelta,
	followDirectionFromKey,
	hasRoomAlong,
	isScrollChainCut,
	isScrollbarGutterHit,
	isScrollContainerOverflow,
	isVerticallyScrollableOverflow,
	nextReaderUpPx,
	readerDisplacementFromKey,
	resolveGestureOwner,
	STICK_TO_BOTTOM_OFFSET_PX,
	type FollowDirection,
	type ScrollChainLink,
} from "./followState";
import { clearResizeScrollGuard, markResizeScrollGuard } from "./resizeScrollGuard";

export type { Animation, SpringAnimation } from "./mergeAnimations";
export {
	AT_BOTTOM_TOLERANCE_PX,
	decideFollowFromUserInput,
	shouldRelockFromDownInput,
	STICK_TO_BOTTOM_OFFSET_PX,
} from "./followState";

const SIXTY_FPS_INTERVAL_MS = 1000 / 60;
const RETAIN_ANIMATION_DURATION_MS = 350;

/**
 * 从手势起点向**外**收集完整的滚动链（含引擎自己的 scroller），供 `resolveGestureOwner` 判定归属。
 *
 * 不能用「第一个 overflow-y 容器」代替：浏览器会继续往外找第一个在该方向上**真有余量**的一环
 * （2026-08 探针：代码块到顶 ⊂ 已上滚的组体 → 滚的是组体）；中途遇到已到边且
 * `overscroll-behavior-y: contain | none` 的环就直接断链（谁都不滚）。
 */
function collectScrollChain(scroll: HTMLElement, target: EventTarget | null, direction: FollowDirection): ScrollChainLink[] {
	const chain: ScrollChainLink[] = [];
	// wheel/键盘事件常落在文本节点上（或 event.target 为 null，如程序化 noteWheel）。
	let element: HTMLElement | null = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : scroll;
	// 起点可能在 scroller 之外（如 composer 区域的滚轮路由进来）：那样直接算时间线手势。
	let inside = false;
	while (element) {
		const style = getComputedStyle(element);
		const isTimeline = element === scroll;
		chain.push({
			isTimeline,
			isScrollContainer: isScrollContainerOverflow(style.overflowY),
			// hidden 可程序化滚动却不接收用户滚轮；仍保留其 overscroll-behavior 断链语义。
			canScrollAlong: isVerticallyScrollableOverflow(style.overflowY) && hasRoomAlong(element, direction),
			chainCut: isScrollChainCut(style.overscrollBehaviorY),
		});
		if (isTimeline) {
			inside = true;
			break;
		}
		element = element.parentElement;
	}
	// 起点不在时间线内（外部路由的 wheel）：链上只有非时间线环，视为时间线手势。
	if (!inside) chain.push({ isTimeline: true, isScrollContainer: false, canScrollAlong: false, chainCut: false });
	return chain;
}

/** 用户真实滚动意图：向上浏览历史 / 向下回到尾部。
 *  与 layout 滚动（resize/动画/程序化定位）严格区分：意图只由用户
 *  wheel/触摸/滚动条等真实输入产生；内容收缩导致的 scrollTop clamp 不上报。
 *  时间线 controller 的历史扩窗只消费该意图，修复「clamp 被误判为用户上滑」，
 *  导致运行中脱离吸底、回底按钮连点无效的问题（见 scrollHistoryPolicy）。 */
export type ScrollUserIntent = "up" | "down";

/**
 * 用户意图的来源：
 * - "input"：真实 wheel/touch 输入（浏览器默认滚动尚未发生），unambiguous；
 * - "scroll"：scroll 事件派生的方向判断（可能是本组件程序化滚动/动画自激发的
 *   scrollTop 变化，必须由 programmaticScroll 窗口抑制，不能当作真实用户输入）。
 */
export type ScrollIntentSource = "scroll" | "input";

export interface ScrollElements {
	scrollElement: HTMLElement;
	contentElement: HTMLElement;
}

export type GetTargetScrollTop = (targetScrollTop: number, context: ScrollElements) => number;

export interface StickToBottomOptions extends SpringAnimation {
	resize?: Animation;
	initial?: Animation | boolean;
	targetScrollTop?: GetTargetScrollTop;
	/**
	 * 内容高度单次增长超过该像素时，resize 强制 instant。
	 * 工具卡/折叠栏等离散跳变若仍走弹簧，会出现「先撑上去再弹回」的砰抖。
	 * 小幅增长（正文逐字）仍用 resize 弹簧。
	 * @default 28
	 */
	instantResizeThreshold?: number;
	/**
	 * 用户滚动意图回调（上滚/下滚）。每个符合逃逸/重锁语义的输入事件都会上报；
	 * resize、引擎动画和通过原子 API 的程序化定位不会上报。
	 * 时间线 controller 据此把「用户浏览历史」与「布局滚动」分开，
	 * 修复 clamp scrollTop 被误判为上滑导致运行中脱离吸底的问题。
	 */
	onUserIntent?: (intent: ScrollUserIntent, source: ScrollIntentSource) => void;
}

export type ScrollToBottomOptions =
	| ScrollBehavior
	| {
			/**
			 * Whether to wait for any existing scrolls to finish before
			 * performing this one. Or if a millisecond is passed,
			 * it will wait for that duration before performing the scroll.
			 *
			 * @default false
			 */
			wait?: boolean | number;
			/**
			 * Whether to prevent the user from escaping the scroll,
			 * by scrolling up with their mouse.
			 */
			ignoreEscapes?: boolean;
			/**
			 * Only scroll to the bottom if we're already at the bottom.
			 *
			 * @default false
			 */
			preserveScrollPosition?: boolean;
			/**
			 * The extra duration in ms that this scroll event should persist for.
			 * (in addition to the time that it takes to get to the bottom)
			 *
			 * Not to be confused with the duration of the animation -
			 * for that you should adjust the animation option.
			 *
			 * @default 0
			 */
			duration?: number | Promise<void>;
			/**
			 * The animation to use for the scroll.
			 */
			animation?: Animation;
	  };

export type ScrollToBottom = (scrollOptions?: ScrollToBottomOptions) => Promise<boolean> | boolean;

export type StopScroll = () => void;
export type ScrollByWheel = (deltaY: number) => void;
/** 只根据滚轮 delta 更新跟随态，不改 scrollTop（浏览器 / 调用方负责位移）。 */
export type NoteWheel = (deltaY: number, target?: EventTarget | null) => void;

/** 原子恢复任意滚动位置（会话切换回历史查看位置用）。
 *  与原生 scrollTop 赋值的区别：定位 + 解锁锁底 + 取消在途动画一次完成，
 *  不依赖异步 scroll 事件让引擎「猜」意图——busy 场景 ResizeObserver 高频贴底
 *  会抢先于解锁事件，导致恢复位置被立刻拽回底部（双真相源竞态）。 */
export type RestoreAt = (scrollTop: number) => void;

export interface StickToBottomState {
	scrollTop: number;
	lastScrollTop?: number;
	ignoreScrollToTop?: number;
	targetScrollTop: number;
	calculatedTargetScrollTop: number;
	scrollDifference: number;
	resizeDifference: number;
	/** Resize guard generation; equal-sized consecutive changes must remain distinguishable. */
	resizeGeneration: number;
	/** 每次新开滚动会话递增；在途 rAF 发现代数过期则退出，避免与同步校正打架。 */
	scrollGeneration: number;
	animation?: {
		behavior: "instant" | Required<SpringAnimation>;
		ignoreEscapes: boolean;
		promise: Promise<boolean>;
	};
	lastTick?: number;
	velocity: number;
	accumulated: number;
	escapedFromLock: boolean;
	isAtBottom: boolean;
	isNearBottom: boolean;
	resizeObserver?: ResizeObserver;
	scrollResizeObserver?: ResizeObserver;
}

export interface StickToBottomInstance {
	contentRef: React.MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
	scrollRef: React.MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
	scrollToBottom: ScrollToBottom;
	stopScroll: StopScroll;
	scrollByWheel: ScrollByWheel;
	noteWheel: NoteWheel;
	/** 原子恢复位置：写 scrollTop 的同时解除锁底并取消在途弹簧动画。 */
	restoreAt: RestoreAt;
	isAtBottom: boolean;
	isNearBottom: boolean;
	escapedFromLock: boolean;
	state: StickToBottomState;
}

let mouseDown = false;
if (typeof document !== "undefined") {
	document.addEventListener("mousedown", () => {
		mouseDown = true;
	});
	document.addEventListener("mouseup", () => {
		mouseDown = false;
	});
	document.addEventListener("click", () => {
		mouseDown = false;
	});
}

export const useStickToBottom = (options: StickToBottomOptions = {}): StickToBottomInstance => {
	const [escapedFromLock, updateEscapedFromLock] = useState(false);
	const [isAtBottom, updateIsAtBottom] = useState(options.initial !== false);
	const [isNearBottom, setIsNearBottom] = useState(false);
	const optionsRef = useRef<StickToBottomOptions | null>(null);
	optionsRef.current = options;

	const isSelecting = useCallback(() => {
		if (!mouseDown) {
			return false;
		}
		const selection = window.getSelection();
		// A regular click also creates a collapsed Selection. Treating that caret as
		// text selection means any coincident resize/animation scroll escapes the lock
		// and shows the go-bottom button even though the reader never scrolled.
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			return false;
		}
		const range = selection.getRangeAt(0);
		return range.commonAncestorContainer.contains(scrollRef.current as Node) || (scrollRef.current as Node | null)?.contains(range.commonAncestorContainer);
	}, []);

	const setIsAtBottom = useCallback((isAtBottom: boolean) => {
		state.isAtBottom = isAtBottom;
		updateIsAtBottom(isAtBottom);
	}, []);

	const setEscapedFromLock = useCallback((escapedFromLock: boolean) => {
		state.escapedFromLock = escapedFromLock;
		updateEscapedFromLock(escapedFromLock);
	}, []);

	/**
	 * 每次已确认的用户滚动都独立上报。方向不是可去重的状态：
	 * 「上滚 → 回底 → 再上滚」是两个不同浏览周期，第二次 up 仍必须通知 controller。
	 */
	const reportUserIntent = useCallback((intent: ScrollUserIntent, source: ScrollIntentSource) => {
		optionsRef.current?.onUserIntent?.(intent, source);
	}, []);

	const inputSessionRef = useRef({
		pointer: false,
		touch: false,
		readerUpPx: 0,
		lastUpAt: 0,
	});

	const resetReaderUp = useCallback(() => {
		inputSessionRef.current.readerUpPx = 0;
		inputSessionRef.current.lastUpAt = 0;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: state intentionally created once
	const state = useMemo<StickToBottomState>(() => {
		let lastCalculation: { targetScrollTop: number; calculatedScrollTop: number } | undefined;
		return {
			escapedFromLock,
			isAtBottom,
			resizeDifference: 0,
			resizeGeneration: 0,
			scrollGeneration: 0,
			accumulated: 0,
			velocity: 0,
			get scrollTop() {
				return scrollRef.current?.scrollTop ?? 0;
			},
			set scrollTop(scrollTop: number) {
				if (scrollRef.current) {
					scrollRef.current.scrollTop = scrollTop;
					state.ignoreScrollToTop = scrollRef.current.scrollTop;
				}
			},
			get targetScrollTop() {
				if (!scrollRef.current || !contentRef.current) {
					return 0;
				}
				return scrollRef.current.scrollHeight - 1 - scrollRef.current.clientHeight;
			},
			get calculatedTargetScrollTop() {
				if (!scrollRef.current || !contentRef.current) {
					return 0;
				}
				const { targetScrollTop } = this;
				if (!optionsRef.current?.targetScrollTop) {
					return targetScrollTop;
				}
				if (lastCalculation?.targetScrollTop === targetScrollTop) {
					return lastCalculation.calculatedScrollTop;
				}
				const calculatedScrollTop = Math.max(
					Math.min(
						optionsRef.current.targetScrollTop(targetScrollTop, {
							scrollElement: scrollRef.current,
							contentElement: contentRef.current,
						}),
						targetScrollTop,
					),
					0,
				);
				lastCalculation = { targetScrollTop, calculatedScrollTop };
				requestAnimationFrame(() => {
					lastCalculation = undefined;
				});
				return calculatedScrollTop;
			},
			get scrollDifference() {
				return this.calculatedTargetScrollTop - this.scrollTop;
			},
			get isNearBottom() {
				return this.scrollDifference <= STICK_TO_BOTTOM_OFFSET_PX;
			},
		};
	}, []);

	const scrollToBottom = useCallback<ScrollToBottom>(
		(scrollOptions = {}) => {
			if (typeof scrollOptions === "string") {
				scrollOptions = { animation: scrollOptions };
			}
			if (!scrollOptions.preserveScrollPosition) {
				resetReaderUp();
				setIsAtBottom(true);
			}
			const waitElapsed = Date.now() + (Number(scrollOptions.wait) || 0);
			const behavior = mergeAnimations(optionsRef.current ?? {}, scrollOptions.animation);
			const { ignoreEscapes = false, preserveScrollPosition = false } = scrollOptions;
			let durationElapsed: number;
			let startTarget = state.calculatedTargetScrollTop;
			if (scrollOptions.duration instanceof Promise) {
				scrollOptions.duration.finally(() => {
					durationElapsed = Date.now();
				});
			} else {
				durationElapsed = waitElapsed + (scrollOptions.duration ?? 0);
			}
			// instant 不复用在途动画：旧闭包的 startTarget 会把连续增高拖成多帧阶梯。
			if (scrollOptions.wait !== true || behavior === "instant") {
				state.animation = undefined;
			}
			if (state.animation?.behavior === behavior) {
				return state.animation.promise;
			}
			const generation = ++state.scrollGeneration;
			const next = async (): Promise<boolean> => {
				const promise = new Promise(requestAnimationFrame).then(() => {
					if (generation !== state.scrollGeneration) {
						return false;
					}
					if (!state.isAtBottom) {
						state.animation = undefined;
						return false;
					}
					const { scrollTop } = state;
					const tick = performance.now();
					const tickDelta = (tick - (state.lastTick ?? tick)) / SIXTY_FPS_INTERVAL_MS;
					state.animation || (state.animation = { behavior, promise, ignoreEscapes });
					if (state.animation.behavior === behavior) {
						state.lastTick = tick;
					}
					if (isSelecting()) {
						return next();
					}
					if (waitElapsed > Date.now()) {
						return next();
					}
					if (scrollTop < Math.min(startTarget, state.calculatedTargetScrollTop)) {
						if (state.animation?.behavior === behavior) {
							if (behavior === "instant") {
								state.scrollTop = state.calculatedTargetScrollTop;
								return next();
							}
							state.velocity = (behavior.damping * state.velocity + behavior.stiffness * state.scrollDifference) / behavior.mass;
							state.accumulated += state.velocity * tickDelta;
							state.scrollTop += state.accumulated;
							if (state.scrollTop !== scrollTop) {
								state.accumulated = 0;
							}
						}
						return next();
					}
					if (durationElapsed > Date.now()) {
						startTarget = state.calculatedTargetScrollTop;
						return next();
					}
					state.animation = undefined;
					/**
					 * If we're still below the target, then queue
					 * up another scroll to the bottom with the last
					 * requested animation.
					 */
					if (state.scrollTop < state.calculatedTargetScrollTop) {
						return scrollToBottom({
							animation: mergeAnimations(optionsRef.current ?? {}, optionsRef.current?.resize),
							ignoreEscapes,
							preserveScrollPosition,
							duration: Math.max(0, durationElapsed - Date.now()) || undefined,
						});
					}
					return state.isAtBottom;
				});
				return promise.then((isAtBottomResult: boolean) => {
					requestAnimationFrame(() => {
						if (!state.animation) {
							state.lastTick = undefined;
							state.velocity = 0;
						}
					});
					return isAtBottomResult;
				});
			};
			return next();
		},
		[resetReaderUp, setIsAtBottom, isSelecting, state],
	);

	const stopScroll = useCallback(() => {
		resetReaderUp();
		setEscapedFromLock(true);
		setIsAtBottom(false);
	}, [resetReaderUp, setEscapedFromLock, setIsAtBottom]);

	/**
	 * 原子恢复位置（会话切换回历史查看位置）。
	 * 与「原生赋值 scrollTop + 依赖 scroll 事件被动解锁」的区别：
	 * - scrollGeneration += 1：在途弹簧动画的 next() 会因代数过期直接退出，
	 *   避免下一帧把刚恢复的位置又写回底部；
	 * - animation = undefined：清理动画状态，防止保留期内的重复滚底；
	 * - setEscapedFromLock(true) + setIsAtBottom(false)：立即解锁锁底，
	 *   busy 会话的 ResizeObserver（instant 贴底）看到 isAtBottom=false 不再拽回。
	 * - state.scrollTop 写入会设置 ignoreScrollToTop，后续 scroll 事件被引擎忽略，
	 *   不会误判为「用户滚动」重新锁底。
	 */
	const restoreAt = useCallback(
		(scrollTop: number) => {
			state.scrollGeneration += 1;
			state.animation = undefined;
			resetReaderUp();
			setEscapedFromLock(true);
			setIsAtBottom(false);
			state.scrollTop = Math.max(0, scrollTop);
		},
		[resetReaderUp, setEscapedFromLock, setIsAtBottom, state],
	);

	const boundScrollRef = useRef<HTMLElement | null>(null);

	const applyUserInput = useCallback(
		(direction: "up" | "down", thisInputPx: number, distanceFromBottom: number, canScroll: boolean): void => {
			const next = nextReaderUpPx({
				previous: inputSessionRef.current.readerUpPx,
				previousAt: inputSessionRef.current.lastUpAt,
				now: performance.now(),
				direction,
				thisInputPx,
			});
			inputSessionRef.current.readerUpPx = next.readerUpPx;
			inputSessionRef.current.lastUpAt = next.at;
			const decision = decideFollowFromUserInput({
				direction,
				readerDisplacementPx: next.readerUpPx,
				distanceFromBottom,
				ignoreEscapes: Boolean(state.animation?.ignoreEscapes),
				canScroll,
			});
			if (decision.action === "none") return;
			reportUserIntent(decision.report, "input");
			if (decision.action === "escape") {
				resetReaderUp();
				setEscapedFromLock(true);
				setIsAtBottom(false);
				return;
			}
			if (decision.action === "relock") {
				resetReaderUp();
				setEscapedFromLock(false);
				setIsAtBottom(true);
			}
		},
		[reportUserIntent, resetReaderUp, setEscapedFromLock, setIsAtBottom, state],
	);

	/**
	 * 只有拖滚动条 / 触摸 / 非折叠拖选才让随后的 scroll 改跟随态。
	 * 滚轮和键盘在各自事件里已经按「读者位移」决策，不得再把 32ms 窗口
	 * 里的布局 clamp 算成用户上翻。
	 */
	const isUserDrivenScroll = useCallback(() => {
		return inputSessionRef.current.pointer || inputSessionRef.current.touch || isSelecting();
	}, [isSelecting]);

	const handleScroll = useCallback(
		({ target }: Event) => {
			if (target !== scrollRef.current) {
				return;
			}
			const { scrollTop, ignoreScrollToTop } = state;
			let { lastScrollTop = scrollTop } = state;
			state.lastScrollTop = scrollTop;
			state.ignoreScrollToTop = undefined;
			if (ignoreScrollToTop && ignoreScrollToTop > scrollTop) {
				lastScrollTop = ignoreScrollToTop;
			}
			setIsNearBottom(state.isNearBottom);
			if (state.animation?.ignoreEscapes) {
				state.scrollTop = lastScrollTop;
				return;
			}
			// 布局 scroll 只更新几何。已确认的拖动不得再被 resizeDifference 丢弃，
			// 否则流式增高期间拖滚动条会被引擎反手拽回底部。
			if (!isUserDrivenScroll()) {
				return;
			}
			const direction = scrollTop < lastScrollTop ? "up" : scrollTop > lastScrollTop ? "down" : undefined;
			if (!direction) {
				return;
			}
			const distanceFromBottom = (scrollRef.current?.scrollHeight ?? 0) - scrollTop - (scrollRef.current?.clientHeight ?? 0);
			applyUserInput(direction, Math.abs(scrollTop - lastScrollTop), distanceFromBottom, Boolean(scrollRef.current && scrollRef.current.scrollHeight > scrollRef.current.clientHeight));
		},
		[applyUserInput, isUserDrivenScroll, state],
	);

	const applyWheelOnScroll = useCallback(
		(element: HTMLElement, deltaY: number) => {
			if (deltaY === 0) return;
			const currentDistance = element.scrollHeight - element.scrollTop - element.clientHeight;
			const predictedDistance = distanceAfterWheelDelta(currentDistance, deltaY);
			applyUserInput(deltaY < 0 ? "up" : "down", Math.abs(deltaY), predictedDistance, element.scrollHeight > element.clientHeight);
		},
		[applyUserInput],
	);

	const applyWheelEscape = useCallback(
		(target: EventTarget | null, deltaY: number) => {
			const scroll = scrollRef.current;
			if (!scroll || deltaY === 0) return;
			// 归属判定：只有“真的会滚时间线”的手势才允许改跟随态。
			if (resolveGestureOwner(collectScrollChain(scroll, target, deltaY < 0 ? "up" : "down")) !== "timeline") return;
			applyWheelOnScroll(scroll, deltaY);
		},
		[applyWheelOnScroll],
	);

	const endPointerSession = useCallback(() => {
		inputSessionRef.current.pointer = false;
		document.removeEventListener("pointerup", endPointerSession);
		document.removeEventListener("pointercancel", endPointerSession);
	}, []);

	const handlePointerDown = useCallback(
		(event: PointerEvent) => {
			const scroll = scrollRef.current;
			if (!scroll) return;
			const rect = scroll.getBoundingClientRect();
			if (!isScrollbarGutterHit(event.clientX, rect.left, scroll.clientWidth)) {
				return;
			}
			inputSessionRef.current.pointer = true;
			document.addEventListener("pointerup", endPointerSession);
			document.addEventListener("pointercancel", endPointerSession);
		},
		[endPointerSession],
	);

	const handleTouchStart = useCallback(() => {
		inputSessionRef.current.touch = true;
	}, []);

	const handleTouchEnd = useCallback((event: TouchEvent) => {
		if (event.touches.length === 0) {
			inputSessionRef.current.touch = false;
		}
	}, []);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const direction = followDirectionFromKey(event.key);
			const scroll = scrollRef.current;
			if (!direction || !scroll) return;
			// 键盘滚动同样要看向上链（探针 K7 / B：键盘手势在含 contain 的嵌套容器到边时谁都不滚，
			// 而代码块到边时浏览器滚的是外层组体，不是时间线），否则会把死手势或内层手势
			// 当成时间线手势：窗口一像素没动，跟随态却已经变了。
			if (resolveGestureOwner(collectScrollChain(scroll, event.target, direction)) !== "timeline") return;
			const thisInputPx = readerDisplacementFromKey(event.key, scroll.clientHeight);
			const currentDistance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
			const predictedDistance = distanceAfterWheelDelta(currentDistance, direction === "down" ? thisInputPx : -thisInputPx);
			applyUserInput(direction, thisInputPx, predictedDistance, scroll.scrollHeight > scroll.clientHeight);
		},
		[applyUserInput],
	);

	const scrollRef = useRefCallback((scroll) => {
		const previous = boundScrollRef.current;
		previous?.removeEventListener("scroll", handleScroll);
		previous?.removeEventListener("pointerdown", handlePointerDown);
		previous?.removeEventListener("touchstart", handleTouchStart);
		previous?.removeEventListener("touchend", handleTouchEnd);
		previous?.removeEventListener("touchcancel", handleTouchEnd);
		previous?.removeEventListener("keydown", handleKeyDown);
		boundScrollRef.current = scroll;
		if (!scroll) {
			endPointerSession();
			inputSessionRef.current.touch = false;
		}
		scroll?.addEventListener("scroll", handleScroll, { passive: true });
		scroll?.addEventListener("pointerdown", handlePointerDown);
		scroll?.addEventListener("touchstart", handleTouchStart, { passive: true });
		scroll?.addEventListener("touchend", handleTouchEnd, { passive: true });
		scroll?.addEventListener("touchcancel", handleTouchEnd, { passive: true });
		scroll?.addEventListener("keydown", handleKeyDown);

		state.scrollResizeObserver?.disconnect();
		state.scrollResizeObserver = undefined;
		if (!scroll) {
			return;
		}

		let previousHeight: number | undefined;
		state.scrollResizeObserver = new ResizeObserver(([entry]) => {
			const { height } = entry.contentRect;
			const difference = height - (previousHeight ?? height);
			previousHeight = height;
			if (!difference) {
				return;
			}

			const resizeGeneration = markResizeScrollGuard(state, difference);

			/**
			 * Composer widgets and sibling panels consume height from the timeline without
			 * changing message content. Preserve the physical bottom synchronously so no
			 * stale-scroll frame is painted. Escaped readers keep their history position.
			 */
			if (difference < 0 && state.isAtBottom) {
				state.scrollGeneration += 1;
				state.animation = undefined;
				state.scrollTop = state.calculatedTargetScrollTop;
			}
			setIsNearBottom(state.isNearBottom);

			// A growing viewport may clamp scrollTop upward. Keep that browser-generated
			// scroll event inside the same resize guard instead of reporting reader intent.
			requestAnimationFrame(() => {
				setTimeout(() => {
					clearResizeScrollGuard(state, resizeGeneration);
				}, 1);
			});
		});
		state.scrollResizeObserver.observe(scroll);
	}, []);

	/** Uses the same wheel-escape rules when input originates outside the viewport. */
	const noteWheel = useCallback<NoteWheel>(
		(deltaY, target) => {
			const scroll = scrollRef.current;
			if (!scroll || !Number.isFinite(deltaY) || deltaY === 0) return;
			if (target) {
				applyWheelEscape(target, deltaY);
				return;
			}
			applyWheelOnScroll(scroll, deltaY);
		},
		[applyWheelEscape, applyWheelOnScroll],
	);

	const scrollByWheel = useCallback<ScrollByWheel>(
		(deltaY) => {
			const scroll = scrollRef.current;
			if (!scroll || !Number.isFinite(deltaY) || deltaY === 0) return;
			applyWheelOnScroll(scroll, deltaY);
			scroll.scrollBy({ top: deltaY });
		},
		[applyWheelOnScroll],
	);
	const contentRef = useRefCallback((content) => {
		state.resizeObserver?.disconnect();
		if (!content) {
			return;
		}
		let previousHeight: number | undefined;
		state.resizeObserver = new ResizeObserver(([entry]) => {
			const { height } = entry.contentRect;
			const difference = height - (previousHeight ?? height);
			const resizeGeneration = markResizeScrollGuard(state, difference);
			/**
			 * Sometimes the browser can overscroll past the target,
			 * so check for this and adjust appropriately.
			 */
			if (state.scrollTop > state.targetScrollTop) {
				state.scrollTop = state.targetScrollTop;
			}
			setIsNearBottom(state.isNearBottom);
			if (difference >= 0) {
				// 内容增高只校正几何：已跟随则贴底，已浏览则不动。
				// 这里不再自动恢复已逃逸的锁底（曾用 isNearBottom<=70px 判定）。
				/**
				 * If it's a positive resize, scroll to the bottom when
				 * we're already at the bottom.
				 * 大块离散增高（工具卡入场等）强制 instant，避免弹簧滞后造成砰抖；
				 * 小幅增长保留配置的 resize 动画（逐字跟底）。
				 *
				 * instant 必须在本 RO 回调内同步写 scrollTop：
				 * RO 在 paint 前触发，而 scrollToBottom 的 rAF 要等到下一帧——
				 * 中间那一帧旧 scrollTop 就是工具卡「砰」一下的根因。
				 */
				const requested = mergeAnimations(optionsRef.current ?? {}, previousHeight ? optionsRef.current?.resize : optionsRef.current?.initial);
				const threshold = optionsRef.current?.instantResizeThreshold ?? 28;
				const animation = previousHeight && difference > threshold && requested !== "instant" ? "instant" : requested;
				if (animation === "instant") {
					// preserveScrollPosition：仅已锁底时跟随，不把用户上滚强拽回来
					if (state.isAtBottom) {
						state.scrollGeneration += 1;
						state.animation = undefined;
						state.scrollTop = state.calculatedTargetScrollTop;
					}
				} else {
					scrollToBottom({
						animation,
						wait: true,
						preserveScrollPosition: true,
						duration: RETAIN_ANIMATION_DURATION_MS,
					});
				}
			}
			// 内容收缩只记录几何，不改跟随态。浏览中的用户即使被 clamp 到近底圈，
			// 也必须自己下滚或点回底才能重新跟随。
			previousHeight = height;
			/**
			 * Reset the resize difference after the scroll event has fired.
			 * rAF waits for that scroll; +1ms covers RO/scroll 交错。
			 */
			requestAnimationFrame(() => {
				setTimeout(() => {
					clearResizeScrollGuard(state, resizeGeneration);
				}, 1);
			});
		});
		state.resizeObserver?.observe(content);
	}, []);

	return {
		contentRef,
		scrollRef,
		scrollToBottom,
		stopScroll,
		scrollByWheel,
		noteWheel,
		restoreAt,
		/**
		 * 对外「是否锁底跟随」只用严格 isAtBottom。
		 * 旧实现 `isAtBottom || isNearBottom` 会在用户已上滚但距底 <70px 时仍报跟随，
		 * ResizeObserver 继续拽底 → 触底附近周期性上跳/回弹。
		 */
		isAtBottom,
		isNearBottom,
		escapedFromLock,
		state,
	};
};

type RefCallbackRef<T> = React.MutableRefObject<T | null> & React.RefCallback<T>;

function useRefCallback<T extends HTMLElement>(callback: (ref: T | null) => void, deps: React.DependencyList): RefCallbackRef<T> {
	// biome-ignore lint/correctness/useExhaustiveDependencies: ref identity must be stable
	const result = useCallback((ref: T | null) => {
		(result as RefCallbackRef<T>).current = ref;
		return callback(ref);
	}, deps) as unknown as RefCallbackRef<T>;
	return result;
}
