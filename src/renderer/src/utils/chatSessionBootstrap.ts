import type { AgentBackend, AvailableModel } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";

export type ChatSessionBootstrapAction = { kind: "none" } | { kind: "load" } | { kind: "wait" };

/**
 * 引导页空白输入框的 renderer-only 虚拟会话 ID：无会话打开时（启动 / 清空 Tab /
 * 空项目）引导页直接挂居中 ComposerArea，此 ID 只存在于渲染层 atoms，不落
 * Catalog；用户首次发送时由 App.ensureSessionForSend 创建真实会话（Chat 匿名 /
 * 非 Chat draft）并把 composer 状态整体提升过去。
 */
export const GUIDE_BOOTSTRAP_SESSION_ID = "renderer:guide-bootstrap";

/** 欢迎页（未启动 Agent）选择的模型偏好存储 key。 */
export const WELCOME_MODEL_KEY = "pideck:welcome-model";
/**
 * 引导页切到 DSH 后的模型偏好存储 key（与 pi 的 WELCOME_MODEL_KEY 分开）。
 *
 * 必须独立存储：两份偏好被不同解析器消费——pi 侧进 launchDefaults（读 models.json），
 * DSH 侧进 createDraft 的显式 model（读 host 模型目录）。共用一个 key 会让两侧互相
 * 读到对方的模型：切到 DSH 后 pi 偏好里的 models.json 模型会被当成 DSH 选择，
 * 而 DSH 的 route 名（如 jiyuan）回切 pi 后又会被当成 models.json 的 provider。
 */
export const WELCOME_DSH_MODEL_KEY = "pideck:welcome-dsh-model";
/** 欢迎页（未启动 Agent）显式选择的思考级别存储 key；首次发送时提升到真实会话。 */
export const WELCOME_THINKING_KEY = "pideck:welcome-thinking";
/** 欢迎页（未启动 Agent）显式切换的后端存储 key；首次发送时提升到真实会话。 */
export const WELCOME_BACKEND_KEY = "pideck:welcome-backend";

/** 读取欢迎页最后显式切换的后端（pi/dsh/acp；无则 undefined）。 */
export function readWelcomeBackendPreference(): AgentBackend | undefined {
	try {
		const raw = localStorage.getItem(WELCOME_BACKEND_KEY);
		// imagegen 是模式不是后端切换器的取值，历史脏数据一律忽略。
		// acp 偏好携带工具 id（"acp:<toolId>"），后端枚举与工具分别读取。
		if (raw === "pi" || raw === "dsh") return raw;
		if (raw !== null && raw.startsWith("acp:")) return "acp";
	} catch {
		// localStorage 不可用时视为无偏好
	}
	return undefined;
}

/** 读取欢迎页 ACP 偏好携带的工具 id（非 acp 偏好/无工具段时 undefined）。 */
export function readWelcomeAcpToolPreference(): string | undefined {
	try {
		const raw = localStorage.getItem(WELCOME_BACKEND_KEY);
		if (raw === null || !raw.startsWith("acp:")) return undefined;
		const toolId = raw.slice("acp:".length);
		return toolId || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 引导页实际会创建的后端：用户显式切换优先，但 DSH runtime 不可用时回落 pi。
 *
 * 为什么必须是纯函数并被展示与创建两侧共用：底栏/选择器按它选目录与默认值
 * （pi 读 models.json、DSH 读 host catalog），`ensureSessionForSend` 按它建会话。
 * 两侧各写一份就会分叉——用户看到 DSH 目录却建出 pi 会话（或反之）。
 *
 * 钳制规则与 `resolveEffectiveAgentBackend` 同源：DSH 不可用时不能让新建落到 dsh，
 * 否则首次发送才在 createDraft 的 runtime 门控上抛错。
 */
export function resolveGuidePageBackend(input: {
	/** 引导页显式切换的后端（localStorage 偏好，无则 undefined）。 */
	override?: AgentBackend;
	/** 引导页 ACP 偏好携带的工具 id（无则 acp 偏好不成立，回落 pi——建不出会话）。 */
	acpToolId?: string;
	/** 设置项默认后端，已经过 DSH runtime 安装态钳制（effectiveAgentBackendAtom）。 */
	effectiveDefault: AgentBackend;
}): AgentBackend {
	if (input.override === "dsh" && input.effectiveDefault !== "dsh") return "pi";
	// acp 必须有工具 id（偏好残留但工具已被删时回落，首次发送才不会报错）
	if (input.override === "acp" && !input.acpToolId) return "pi";
	return input.override ?? input.effectiveDefault;
}

/** 读取欢迎页最后选择的模型偏好（无则 undefined）。 */
export function readWelcomeModelPreference():
	| {
			model: { provider: string; modelId: string; modelName?: string };
	  }
	| undefined {
	return readStoredModelPreference(WELCOME_MODEL_KEY);
}

/** 读取引导页切到 DSH 后选择的模型偏好（无则 undefined）。 */
export function readWelcomeDshModelPreference():
	| {
			model: { provider: string; modelId: string; modelName?: string };
	  }
	| undefined {
	return readStoredModelPreference(WELCOME_DSH_MODEL_KEY);
}

/** 两份引导页模型偏好（pi / dsh）共用的读取与归一化。 */
function readStoredModelPreference(storageKey: string):
	| {
			model: { provider: string; modelId: string; modelName?: string };
	  }
	| undefined {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as { provider?: string; modelId?: string; modelName?: unknown };
		if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
			return {
				model: createSessionModelPreference(parsed.provider, parsed.modelId, parsed.modelName),
			};
		}
	} catch {
		// 解析失败视为无偏好
	}
	return undefined;
}

/** 读取欢迎页最后选择的思考级别（无则 undefined）。 */
export function readWelcomeThinkingPreference(): { thinkingLevel: string } | undefined {
	try {
		const level = localStorage.getItem(WELCOME_THINKING_KEY);
		if (level) return { thinkingLevel: level };
	} catch {
		// 读取失败视为无偏好
	}
	return undefined;
}

/**
 * welcome 偏好（localStorage 残留）中的模型是否已从模型目录消失。
 * 供应商/模型被删除后偏好仍会指向旧模型（用户反馈「模型都删了新建会话还是它」）；
 * 调用方（引导页底栏展示 / 模型选择器）应忽略该偏好并清理 localStorage，
 * 让显示回落到主进程解析的启动默认（launchDefaults 已校验 models.json 存在性）。
 * 目录未就绪（models 为空）时不判定——避免误清仍有效的偏好（目录加载失败场景）。
 */
export function isWelcomeModelLost(welcomeModel: { provider: string; modelId: string } | undefined, models: AvailableModel[]): boolean {
	if (!welcomeModel) return false;
	if (models.length === 0) return false;
	return !models.some((model) => model.provider === welcomeModel.provider && model.id === welcomeModel.modelId);
}

/**
 * 是否该把引导页点选偏好从 localStorage 真的删掉——这是唯一会**销毁**用户点选的路径，
 * 判定必须比展示判定（isWelcomeModelLost）更保守：忽略是临时的、删除是不可逆的。
 *
 * 两道闸门各自的业务理由：
 * - catalogLoaded：偏好是持久数据，而目录可能还在加载中或 IPC 已失败（此时列表为空或残缺）。
 *   拿瞬时状态去毁持久偏好，就是用户反馈的「切了模型但发送后又变回去」的静默丢盘路径。
 * - catalogIsGlobal：偏好存在**全局** localStorage，但 ComposerPickerHost 在有 record 时按
 *   record.projectId 加载**项目范围**目录；项目列表合法地不含该模型时，不能证明全局偏好已死，
 *   否则用户在别的项目里的选择会被无声销毁。
 *
 * 点选已升为创建解析的最高优先级（引导页点选 > 显式默认 > enabledModels > 上次使用），
 * 误删的代价比历史上更大，因此这里宁可不删（残留项由展示层忽略 + 主进程创建时兜底丢弃）。
 */
export function shouldClearWelcomePreference(input: {
	welcomeModel: { provider: string; modelId: string } | undefined;
	models: AvailableModel[];
	/** 目录是否来自一次成功的完整加载（ModelListReport.ok === true）。 */
	catalogLoaded: boolean;
	/** 目录是否按全局范围加载（未传 projectId）。 */
	catalogIsGlobal: boolean;
}): boolean {
	const { welcomeModel, models, catalogLoaded, catalogIsGlobal } = input;
	if (!welcomeModel) return false;
	if (!catalogLoaded || !catalogIsGlobal) return false;
	return isWelcomeModelLost(welcomeModel, models);
}

/**
 * The built-in Chat view needs an identity before the composer renders, but
 * opening the app must not add an unrequested row to history. This renderer-
 * only ID is promoted to a Catalog record only when the user sends.
 */
export function resolveChatSessionBootstrap(input: { isChatProject: boolean; currentSessionId?: string; catalogStatus?: "idle" | "loading" | "ready" | "error" }): ChatSessionBootstrapAction {
	if (!input.isChatProject || input.currentSessionId) return { kind: "none" };
	// The Chat project can remain collapsed in the sidebar, so it cannot rely on
	// the normal expanded-project scan to reach `ready`. Loading its empty catalog
	// gives the sidebar a deterministic point to list history without creating a
	// durable entry or starting pi.
	if (input.catalogStatus === "idle" || input.catalogStatus === "error" || !input.catalogStatus) {
		return { kind: "load" };
	}
	if (input.catalogStatus !== "ready") return { kind: "wait" };
	// 不再自动选中 renderer-only 虚拟会话：聊天项目点开后与普通项目一致，
	// 先显示统一引导页（新建 Agent / 匿名聊天），用户主动选择后才进入 composer。
	// 避免“聊天项目直接落大输入框、普通项目落引导页”的行为分叉。
	return { kind: "none" };
}
