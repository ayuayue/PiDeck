/**
 * Derive the thinking-level text from PiDeck's saved selection.
 * Runtime telemetry remains available elsewhere, but cannot replace the user preference shown
 * in the composer or picker.
 */
export type ThinkingDisplayResult = {
	levels: string[];
	pending: false;
};

export function computeThinkingDisplay(current: string | undefined): ThinkingDisplayResult {
	return {
		levels: current ? [current] : [],
		pending: false,
	};
}

export const CANONICAL_THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 将指定思考档位钳制到模型支持的档位集合内。
 * 策略完全对齐 @earendil-works/pi-ai 的 clampThinkingLevel：
 * 1. 档位在支持列表内直接返回；
 * 2. 否则沿 canonical 档位序优先向上就近查找支持档位；
 * 3. 向上无可退时向下就近查找；
 * 4. 均不匹配时回退到可用列表第一项（或 "off"）。
 */
export function clampThinkingLevelToAllowed(level: string | undefined, allowedLevels?: readonly string[] | readonly { value: string }[]): string | undefined {
	if (!level) return undefined;
	if (!allowedLevels) return level;
	if (allowedLevels.length === 0) return undefined;

	const allowedValues = allowedLevels.map((item) => (typeof item === "string" ? item : item.value));
	if (allowedValues.includes(level)) return level;

	const index = (CANONICAL_THINKING_LEVEL_ORDER as readonly string[]).indexOf(level);
	if (index !== -1) {
		// 1. 优先向上就近匹配（对齐 pi-ai clampThinkingLevel）
		for (let i = index + 1; i < CANONICAL_THINKING_LEVEL_ORDER.length; i++) {
			const candidate = CANONICAL_THINKING_LEVEL_ORDER[i];
			if (allowedValues.includes(candidate)) {
				return candidate;
			}
		}
		// 2. 向上无可退时向下就近匹配
		for (let i = index - 1; i >= 0; i--) {
			const candidate = CANONICAL_THINKING_LEVEL_ORDER[i];
			if (allowedValues.includes(candidate)) {
				return candidate;
			}
		}
	}

	return allowedValues[0] ?? "off";
}

/**
 * 底栏/选择器当前思考档位只读取会话保存的用户选择或引导页默认。
 * runtime 回传值描述执行状态，不能改写 PiDeck 的当前选择。
 * 当传入当前模型的 allowedLevels 时，自动 clamp 到该模型合法的档位。
 */
export function resolveComposerThinkingLevel(input: { record?: string; fallback?: string; allowedLevels?: readonly string[] | readonly { value: string }[] }): string | undefined {
	const raw = input.record ?? input.fallback;
	if (!input.allowedLevels) {
		return raw;
	}
	return clampThinkingLevelToAllowed(raw, input.allowedLevels);
}
