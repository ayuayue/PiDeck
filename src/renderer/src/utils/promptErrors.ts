class PromptDeliveryUnknownError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptDeliveryUnknownError";
	}
}

/**
 * 宿主判定「此刻不可投递」，消息既没送到也不算失败（典型是 pi 正在压缩上下文：
 * 它对本轮任何 prompt 都硬拒，与 streamingBehavior 无关）。
 *
 * 与 PromptDeliveryUnknownError 的区别：那条是「可能已送到」，绝不能再发；
 * 这条是「确定没送到」，必须留着等可投递时再发。
 */
class PromptDeferralError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptDeferralError";
	}
}

export { PromptDeliveryUnknownError, PromptDeferralError };
