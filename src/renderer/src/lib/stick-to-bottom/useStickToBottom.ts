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
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type Animation,
  type SpringAnimation,
  mergeAnimations,
} from "./mergeAnimations";

export type { Animation, SpringAnimation } from "./mergeAnimations";

const STICK_TO_BOTTOM_OFFSET_PX = 70;
/**
 * 距底容差带（dsh-web ChatView 同值 25px）：用户滚动后距底 <= 25px 仍视为「在底部」。
 * 两个用途：
 * 1. 上滚逃逸守卫——流式回复期间滚轮/触控板轻微上滚（含贴底时滚不动产生的滚动事件）
 *    不再误逃逸，底部按钮不会在回复过程中反复闪现（dsh 的 movedByReader + 25px 判定）；
 * 2. wheel 逃逸守卫——贴底/近底时向上滚轮不逃逸（无位移的滚动没有逃逸意图）。
 */
const AT_BOTTOM_TOLERANCE_PX = 25;
/**
 * 流式增长逃逸锁定窗口（ms）：最后一次内容正增长后的窗口内，上滚逃逸受
 * GROWTH_ESCAPE_GUARD_PX 守卫带保护。
 *
 * 为什么需要：流式渲染逐行增高时，弹簧追底动画存在物理滞后（stiffness/damping
 * 参数偏保守），scrollTop 经常落后 target 数十到上百 px——距底远超 25px 容差带。
 * 此时用户/触控板轻微上滚（含惯性、误触）会被误判为「逃逸锁底」，之后内容增长
 * 不再跟随，表现为「推着推着就不动了」，只能手动点回底按钮（2026-08 用户反馈）。
 * 窗口取 500ms 覆盖一次渲染间隔（通常 <200ms）；流式结束约 500ms 后恢复正常逃逸。
 */
const POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS = 500;
/**
 * 增长守卫带（px）：距底 <= 该距离且处于增长活跃窗口时，上滚不逃逸。
 * 与 lockout 窗口组合：流式中轻微上滚（弹簧追赶带内）保持跟随；
 * 距底更远的上滚（明确要读历史）即使流式中也立即逃逸，不被长时间锁死。
 */
const GROWTH_ESCAPE_GUARD_PX = 200;
const SIXTY_FPS_INTERVAL_MS = 1000 / 60;
const RETAIN_ANIMATION_DURATION_MS = 350;

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

/** 下滚输入是否可直接重锁（纯函数，可单测）：物理距底 <= 容差带即重锁。
 *  贴底/近底状态下用户继续下滚不会产生位移，浏览器不派发 scroll 事件，
 *  handleScroll 的重锁路径（isScrollingDown）收不到信号——「已物理到底但逻辑
 *  逃逸，下滑也没反应、回底按钮点多次无效」的卡死根因。在真实下滚输入
 *  （wheel deltaY>0）到达时直接判定，不依赖异步 scroll 事件。 */
export function shouldRelockFromDownInput(
	distanceFromBottom: number,
	tolerancePx = AT_BOTTOM_TOLERANCE_PX,
): boolean {
	return distanceFromBottom <= tolerancePx;
}

/**
 * 是否处于「增长守卫带」：距底 <= GROWTH_ESCAPE_GUARD_PX 且最后一次正增长在
 * POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS 内。守卫带内的上滚不视为逃逸意图——
 * 流式渲染中弹簧追底滞后（距底常 >25px 容差带），轻微上滚/惯性误触会被误判为
 * 用户上滚读历史，导致锁底永久丢失（「推着推着就不动了」，只能手动点回底按钮）。
 * 距底超过守卫带的上滚（明确要读历史）即使流式中也立即逃逸。
 */
function isWithinGrowthGuardBand(
	distanceFromBottom: number,
	state: Pick<StickToBottomState, "lastPositiveResizeAt">,
): boolean {
	return (
		distanceFromBottom <= GROWTH_ESCAPE_GUARD_PX &&
		performance.now() - state.lastPositiveResizeAt < POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS
	);
}

export interface ScrollElements {
  scrollElement: HTMLElement;
  contentElement: HTMLElement;
}

export type GetTargetScrollTop = (
  targetScrollTop: number,
  context: ScrollElements,
) => number;

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

export type ScrollToBottom = (
  scrollOptions?: ScrollToBottomOptions,
) => Promise<boolean> | boolean;

export type StopScroll = () => void;
export type ScrollByWheel = (deltaY: number) => void;

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
  /** 最近一次内容正增长时刻（performance.now，ms）；0 = 尚未增长。 */
  lastPositiveResizeAt: number;
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
}

export interface StickToBottomInstance {
  contentRef: React.MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
  scrollRef: React.MutableRefObject<HTMLElement | null> & React.RefCallback<HTMLElement>;
  scrollToBottom: ScrollToBottom;
  stopScroll: StopScroll;
  scrollByWheel: ScrollByWheel;
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
    if (!selection || !selection.rangeCount) {
      return false;
    }
    const range = selection.getRangeAt(0);
    return (
      range.commonAncestorContainer.contains(scrollRef.current as Node) ||
      (scrollRef.current as Node | null)?.contains(range.commonAncestorContainer)
    );
  }, []);

  const setIsAtBottom = useCallback(
    (isAtBottom: boolean) => {
      state.isAtBottom = isAtBottom;
      updateIsAtBottom(isAtBottom);
    },
    [],
  );

  const setEscapedFromLock = useCallback(
    (escapedFromLock: boolean) => {
      state.escapedFromLock = escapedFromLock;
      updateEscapedFromLock(escapedFromLock);
    },
    [],
  );

  /**
   * 每次已确认的用户滚动都独立上报。方向不是可去重的状态：
   * 「上滚 → 回底 → 再上滚」是两个不同浏览周期，第二次 up 仍必须通知 controller。
   */
  const reportUserIntent = useCallback((intent: ScrollUserIntent, source: ScrollIntentSource) => {
    optionsRef.current?.onUserIntent?.(intent, source);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: state intentionally created once
  const state = useMemo<StickToBottomState>(() => {
    let lastCalculation: { targetScrollTop: number; calculatedScrollTop: number } | undefined;
    return {
      escapedFromLock,
      isAtBottom,
      lastPositiveResizeAt: 0,
      resizeDifference: 0,
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
        setIsAtBottom(true);
      }
      const waitElapsed = Date.now() + (Number(scrollOptions.wait) || 0);
      const behavior = mergeAnimations(optionsRef.current ?? {}, scrollOptions.animation);
      const { ignoreEscapes = false } = scrollOptions;
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
              state.velocity =
                (behavior.damping * state.velocity +
                  behavior.stiffness * state.scrollDifference) /
                behavior.mass;
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
    [setIsAtBottom, isSelecting, state],
  );

  const stopScroll = useCallback(() => {
    setEscapedFromLock(true);
    setIsAtBottom(false);
  }, [setEscapedFromLock, setIsAtBottom]);

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
  const restoreAt = useCallback((scrollTop: number) => {
    state.scrollGeneration += 1;
    state.animation = undefined;
    setEscapedFromLock(true);
    setIsAtBottom(false);
    state.scrollTop = Math.max(0, scrollTop);
  }, [setEscapedFromLock, setIsAtBottom, state]);

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
        /**
         * When the user scrolls up while the animation plays, the `scrollTop` may
         * not come in separate events; if this happens, to make sure `isScrollingUp`
         * is correct, set the lastScrollTop to the ignored event.
         */
        lastScrollTop = ignoreScrollToTop;
      }
      setIsNearBottom(state.isNearBottom);
      /**
       * Scroll events may come before a ResizeObserver event,
       * so in order to ignore resize events correctly we use a
       * timeout.
       *
       * @see https://github.com/WICG/resize-observer/issues/25#issuecomment-248757228
       */
      setTimeout(() => {
        /**
         * When theres a resize difference ignore the resize event.
         */
        if (state.resizeDifference || scrollTop === ignoreScrollToTop) {
          return;
        }
        if (isSelecting()) {
          setEscapedFromLock(true);
          setIsAtBottom(false);
          reportUserIntent("up", "scroll");
          return;
        }
        const isScrollingDown = scrollTop > lastScrollTop;
        const isScrollingUp = scrollTop < lastScrollTop;
        if (state.animation?.ignoreEscapes) {
          state.scrollTop = lastScrollTop;
          return;
        }
        if (isScrollingUp) {
          // dsh-web 式回笼带：上滚后距底 <= 25px 仍视为在底部，不逃逸。
          // 流式回复中用户（或触控板惯性）轻微上滚时，若立刻解锁锁底，
          // 后续内容增长不再贴底，底部按钮随之闪现；只有真正上滚离开实时尾部才解锁。
          const distanceFromBottom =
            (scrollRef.current?.scrollHeight ?? 0) -
            scrollTop -
            (scrollRef.current?.clientHeight ?? 0);
          // 真正进入历史浏览才上报意图（与逃逸同点触发）：容差带内/守卫带内的
          // 轻微上滚不算浏览——避免与后续内容收缩 clamp 叠加出误扩窗。
          if (
            distanceFromBottom > AT_BOTTOM_TOLERANCE_PX &&
            // 增长活跃窗口 + 守卫带：弹簧追底滞后中（距底常 >25px）的轻微上滚
            // 不视为逃逸——「推着推着就不动了」的根因（详见常量注释）。
            !isWithinGrowthGuardBand(distanceFromBottom, state)
          ) {
            reportUserIntent("up", "scroll");
            setEscapedFromLock(true);
            setIsAtBottom(false);
          }
        }
        if (isScrollingDown) {
          reportUserIntent("down", "scroll");
          setEscapedFromLock(false);
        }
        if (!state.escapedFromLock && state.isNearBottom) {
          setIsAtBottom(true);
        }
      }, 1);
    },
    [isSelecting, reportUserIntent, setEscapedFromLock, setIsAtBottom, state],
  );

  const applyWheelEscape = useCallback(
    (target: EventTarget | null, deltaY: number) => {
      if (!(target instanceof HTMLElement)) return;
      let element = target;
      while (!["scroll", "auto"].includes(getComputedStyle(element).overflow)) {
        if (!element.parentElement) {
          return;
        }
        element = element.parentElement;
      }
      if (element !== scrollRef.current) return;
      /**
       * The browser may cancel the scrolling from the mouse wheel
       * if we update it from the animation in meantime.
       * To prevent this, always escape when the wheel is scrolled up.
       */
      if (deltaY < 0) {
        // 真正进入历史浏览才上报意图（与逃逸同点触发）：容差带内/守卫带内的
        // 轻微上滚不算浏览——避免与后续内容收缩 clamp 叠加出误扩窗。
        if (
          scrollRef.current.scrollHeight > scrollRef.current.clientHeight &&
          // dsh-web 式回笼带：距底 <= 25px 时向上滚轮不逃逸。
          // 贴底时滚轮上滚不会产生任何位移（scrollTop 已到 floor），旧逻辑无条件逃逸，
          // 流式回复中滚轮误触/惯性会让底部按钮闪现；距底足够远的上滚才有逃逸意图。
          scrollRef.current.scrollHeight -
            scrollRef.current.scrollTop -
            scrollRef.current.clientHeight >
            AT_BOTTOM_TOLERANCE_PX &&
          // 增长活跃窗口 + 守卫带：弹簧追底滞后中的轻微上滚不逃逸（同上）。
          !isWithinGrowthGuardBand(
            scrollRef.current.scrollHeight -
              scrollRef.current.scrollTop -
              scrollRef.current.clientHeight,
            state,
          ) &&
          !state.animation?.ignoreEscapes
        ) {
          reportUserIntent("up", "input");
          setEscapedFromLock(true);
          setIsAtBottom(false);
        }
        return;
      }
      if (deltaY > 0) {
        // 下滚是真实用户意图；物理近底时直接重锁（无位移的下滚没有 scroll 事件，
        // handleScroll 的重锁路径收不到信号——已到底但逻辑逃逸的卡死根因）。
        reportUserIntent("down", "input");
        const distanceFromBottom =
          scrollRef.current.scrollHeight -
          scrollRef.current.scrollTop -
          scrollRef.current.clientHeight;
        if (shouldRelockFromDownInput(distanceFromBottom)) {
          setEscapedFromLock(false);
          setIsAtBottom(true);
        }
      }
    },
    [reportUserIntent, setEscapedFromLock, setIsAtBottom, state],
  );

  const handleWheel = useCallback(
    ({ target, deltaY }: WheelEvent) => applyWheelEscape(target, deltaY),
    [applyWheelEscape],
  );

  const scrollRef = useRefCallback((scroll) => {
    scrollRef.current?.removeEventListener("scroll", handleScroll);
    scrollRef.current?.removeEventListener("wheel", handleWheel);
    scroll?.addEventListener("scroll", handleScroll, { passive: true });
    scroll?.addEventListener("wheel", handleWheel, { passive: true });
  }, []);

  /** Uses the same wheel-escape rules when input originates outside the viewport. */
  const scrollByWheel = useCallback<ScrollByWheel>((deltaY) => {
    const scroll = scrollRef.current;
    if (!scroll || !Number.isFinite(deltaY) || deltaY === 0) return;
    applyWheelEscape(scroll, deltaY);
    scroll.scrollBy({ top: deltaY });
  }, [applyWheelEscape]);
  const contentRef = useRefCallback((content) => {
    state.resizeObserver?.disconnect();
    if (!content) {
      return;
    }
    let previousHeight: number | undefined;
    state.resizeObserver = new ResizeObserver(([entry]) => {
      const { height } = entry.contentRect;
      const difference = height - (previousHeight ?? height);
      state.resizeDifference = difference;
      /**
       * Sometimes the browser can overscroll past the target,
       * so check for this and adjust appropriately.
       */
      if (state.scrollTop > state.targetScrollTop) {
        state.scrollTop = state.targetScrollTop;
      }
      setIsNearBottom(state.isNearBottom);
      if (difference >= 0) {
        // 流式增长活跃窗口：任何正增长都刷新逃逸锁定计时（见常量注释）。
        state.lastPositiveResizeAt = performance.now();
        // 注意：这里不再自动恢复已逃逸的锁底（曾用 isNearBottom<=70px 判定）。
        // 会话输出完成后仍有正增长（settle 全量渲染/图片加载/尾部组件），
        // 用户上滚 25~70px 读历史会被反复拽回底部，无法阅读上方内容；
        // 逃逸后只能由用户主动下滚回近底带（handleScroll 重锁路径）恢复。
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
        const requested = mergeAnimations(
          optionsRef.current ?? {},
          previousHeight ? optionsRef.current?.resize : optionsRef.current?.initial,
        );
        const threshold = optionsRef.current?.instantResizeThreshold ?? 28;
        const animation =
          previousHeight &&
          difference > threshold &&
          requested !== "instant"
            ? "instant"
            : requested;
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
      } else {
        /**
         * Else if it's a negative resize, check if we're near the bottom
         * if we are want to un-escape from the lock, because the resize
         * could have caused the container to be at the bottom.
         *
         * 逃逸守卫（与 handleScroll 的重锁路径同一规则）：只有「用户从未上滚逃逸」
         * 时才允许负增长把近底状态重新锁底。已逃逸用户（上滚读历史）即使距底 <70px
         * 也不被负增长拽回——流式中中间回复 message_end 会经历 live 挂载点（折叠外）
         * 先卸载、History 落库后 settled 再进折叠（折叠内）的两帧高度往返，若无守卫，
         * 负增长帧会把读历史的用户误重锁，随后正增长帧 instant 拽底（先上后下抖动）。
         */
        if (!state.escapedFromLock && state.isNearBottom) {
          setEscapedFromLock(false);
          setIsAtBottom(true);
        }
      }
      previousHeight = height;
      /**
       * Reset the resize difference after the scroll event
       * has fired. Requires a rAF to wait for the scroll event,
       * and a setTimeout to wait for the other timeout we have in
       * resizeObserver in case the scroll event happens after the
       * resize event.
       */
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (state.resizeDifference === difference) {
            state.resizeDifference = 0;
          }
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

function useRefCallback<T extends HTMLElement>(
  callback: (ref: T | null) => void,
  deps: React.DependencyList,
): RefCallbackRef<T> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref identity must be stable
  const result = useCallback(
    (ref: T | null) => {
      (result as RefCallbackRef<T>).current = ref;
      return callback(ref);
    },
    deps,
  ) as unknown as RefCallbackRef<T>;
  return result;
}

