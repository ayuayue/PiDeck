/**
 * DSH 偏好落地失败时的用户提示载荷（模型 #253 / 权限 #548）。
 *
 * 为什么用 toast（agents:notice）而不是会话内系统消息：DSH 的 runtime.messages 是 host
 * projection 的整段替换（DshAgentManager 里多处 `runtime.messages = projection.messages`），
 * 本地插入的消息下一次投影就被冲掉；toast 通道（useSessionRuntimeBridge → showNotice）
 * 不依赖消息列表，可靠可见。
 *
 * 为什么独立成纯函数：DshAgentManager 已到行数红线，而这里只是载荷拼装，不持有会话状态。
 * agentsNotice 的 t() 不支持占位符：i18nKey 必须是无占位符的完整句子，具体身份放进
 * message，供 key 缺失时兜底显示。
 */

export type DshPreferenceNoticePayload = {
	agentId: string;
	i18nKey: string;
	kind: "warning";
	duration: number;
	message: string;
};

/** 会话保存的模型偏好被 host 拒绝（模型不在 host 目录 / 档位不被支持 / busy）。 */
export function modelPreferenceIgnoredNotice(agentId: string, provider: string, modelId: string): DshPreferenceNoticePayload {
	return {
		agentId,
		i18nKey: "notice.modelPreferenceIgnored",
		kind: "warning",
		duration: 8000,
		message: `模型偏好 ${provider}/${modelId} 未能应用（DSH host 未接受），已沿用当前模型。请重新选择。`,
	};
}

/**
 * 会话保存的权限预设重放失败：本次沿用 host 当前策略、不阻断消息投递（#548）。
 * 必须提示——「底栏显示 danger-full-access、实际跑的是旧策略」比报错更危险。
 */
export function permissionPreferenceIgnoredNotice(agentId: string, preset: string): DshPreferenceNoticePayload {
	return {
		agentId,
		i18nKey: "notice.permissionPreferenceIgnored",
		kind: "warning",
		duration: 8000,
		message: `权限预设 ${preset} 未能应用到 DSH 会话，本次沿用 host 当前策略。请重新切换权限预设。`,
	};
}
