/**
 * stick-to-bottom 动画合并：将 "instant" / "smooth" / 弹簧参数归一为引擎可用的行为。
 *
 * "smooth"（ScrollBehavior 字符串）表示使用默认弹簧，不是 CSS scroll-behavior。
 * 缓存 key 必须包含 instant 标志，否则首次调用会永久污染后续结果。
 */

export interface SpringAnimation {
	damping?: number;
	stiffness?: number;
	mass?: number;
}

export const DEFAULT_SPRING_ANIMATION: Required<SpringAnimation> = {
	/**
	 * A value from 0 to 1, on how much to damp the animation.
	 * 0 means no damping, 1 means full damping.
	 *
	 * @default 0.7
	 */
	damping: 0.7,
	/**
	 * The stiffness of how fast/slow the animation gets up to speed.
	 *
	 * @default 0.05
	 */
	stiffness: 0.05,
	/**
	 * The inertial mass associated with the animation.
	 * Higher numbers make the animation slower.
	 *
	 * @default 1.25
	 */
	mass: 1.25,
};

export type Animation = ScrollBehavior | SpringAnimation;

export type MergeAnimationInput = Animation | SpringAnimation | boolean | undefined | (SpringAnimation & Record<string, unknown>);

const animationCache = new Map<string, "instant" | Required<SpringAnimation>>();

/** 仅供单测：清空模块级缓存，避免用例互相污染。 */
export function clearMergeAnimationsCacheForTests(): void {
	animationCache.clear();
}

export function mergeAnimations(...animations: MergeAnimationInput[]): "instant" | Required<SpringAnimation> {
	const result: Required<SpringAnimation> = { ...DEFAULT_SPRING_ANIMATION };
	let instant = false;
	for (const animation of animations) {
		if (animation === "instant") {
			instant = true;
			continue;
		}
		if (typeof animation !== "object" || animation === null) {
			// "smooth" / true / false / undefined：不改弹簧参数；"smooth" 语义=默认弹簧
			continue;
		}
		instant = false;
		result.damping = animation.damping ?? result.damping;
		result.stiffness = animation.stiffness ?? result.stiffness;
		result.mass = animation.mass ?? result.mass;
	}
	// instant 必须进 key：否则 mount 时一次 instant 会把同弹簧参数的 smooth 永久缓存成 instant
	const key = `${instant ? "instant" : "spring"}:${JSON.stringify(result)}`;
	if (!animationCache.has(key)) {
		animationCache.set(key, instant ? "instant" : Object.freeze({ ...result }));
	}
	return animationCache.get(key)!;
}
