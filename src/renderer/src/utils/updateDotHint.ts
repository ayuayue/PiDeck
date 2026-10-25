/**
 * 更新圆点首次解释气泡（coachmark）的显示判定。
 *
 * 业务规则（对齐 Material Design feature discovery）：
 * 圆点「首次出现」时（hasPendingUpdate 从 false → true 的上升沿）且用户从未
 * 看过解释（hintSeen 未标记）才显示；之后不再打扰，由设置持久化标记兜底。
 */

export type UpdateDotHintInput = {
	/** 当前是否有任一可提示更新（圆点亮）。 */
	hasPendingUpdate: boolean;
	/** 上一帧的 hasPendingUpdate（用于上升沿判定）。 */
	prevHasPendingUpdate: boolean;
	/** 是否已看过圆点解释（updateDotHintSeen 持久化标记）。 */
	hintSeen: boolean;
};

/** 是否应显示首次解释气泡：纯函数，便于单测。 */
export function shouldShowUpdateDotHint(input: UpdateDotHintInput): boolean {
	return input.hasPendingUpdate && !input.prevHasPendingUpdate && !input.hintSeen;
}
