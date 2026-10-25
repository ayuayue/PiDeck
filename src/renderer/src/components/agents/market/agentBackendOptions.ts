import { AGENT_PROFILE_BACKENDS, type AgentProfileBackend } from "../../../../../shared/types/agentProfile";
import { t, type TranslationKey } from "../../../i18n";

/**
 * Select 的 value 必须是字符串，而「跟随默认后端」在契约里是 undefined：
 * 用一个不可能与真实后端重名的哨兵承接，选中哨兵时提交 undefined（主进程按「删除 backend 字段」处理）。
 * 不能直接用空串：Radix SelectItem 禁止 value=""（会抛运行时错误）。
 */
export const FOLLOW_DEFAULT_BACKEND_VALUE = "follow-default";

/** 后端展示文案复用设置页同两个 key，避免市场/设置出现第三套 pi/DSH 命名。 */
export const AGENT_BACKEND_LABEL_KEYS: Record<AgentProfileBackend, TranslationKey> = {
	pi: "settings.defaultAgentBackendPi",
	dsh: "settings.defaultAgentBackendDsh",
};

/** Select 的 value 是 string：只接受契约枚举，脏值不写进表单状态（不写 as 强转）。 */
export function isAgentProfileBackend(value: string): value is AgentProfileBackend {
	return AGENT_PROFILE_BACKENDS.some((backend) => backend === value);
}

/** 后端标签：undefined = 跟随设置里的默认后端（编辑器与详情面板共用同一套文案）。 */
export function agentBackendLabel(backend: AgentProfileBackend | undefined): string {
	return backend ? t(AGENT_BACKEND_LABEL_KEYS[backend]) : t("agentMarket.backendFollow");
}
