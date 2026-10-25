/**
 * DSH 部署默认模型选择解析（settings.yaml 的 agent-default-model 段，纯函数可单测）。
 *
 * 动机：草稿/未启动的 DSH 会话在 host 里还没有会话，wire 上没有「当前部署默认模型」
 * 的 RPC（llm.models 只给目录、session.models 需要会话）。底栏/选择器要展示
 * 默认模型与思考档位，只能从 DSH_HOME/settings.yaml 读取（host 写出的简单 YAML）。
 *
 * 解析实现：DshHost.getDefaultModelSelection 直接读已解析的 settings snapshot 记录
 * （readDshSettingsSnapshot），不做行级 YAML 解析；本文件只保留跨层共享的类型。
 */
export type DshDefaultModel = {
	provider: string;
	model: string;
	reasoningEffort?: string;
};
