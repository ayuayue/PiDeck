import { resolveModelDisplayName } from "../../../shared/modelDisplayName";

/**
 * 后端拒绝运行中模型切换时的 fallback 展示推导。
 *
 * 支持 live selection 的后端直接更新 runtime，不会设置 pending；只有 busy/error
 * 路径才会把选择保留到后续空闲时重试。
 */

export type ModelPendingRef = {
	provider: string;
	modelId: string;
	modelName?: string;
};

export type ModelPending = {
	from: ModelPendingRef;
	to: ModelPendingRef;
};

export function formatModelRef(ref: Pick<ModelPendingRef, "provider" | "modelId" | "modelName">): string {
	const name = ref.modelName || ref.modelId || "-";
	return ref.provider ? `${ref.provider}/${name}` : name;
}

export type ModelDisplayResult = {
	from?: ModelPendingRef;
	to?: ModelPendingRef;
	pending: boolean;
};

export function computeModelDisplay(current: ModelPendingRef | undefined, pending: ModelPending | undefined): ModelDisplayResult {
	if (pending) {
		return { from: pending.from, to: pending.to, pending: true };
	}
	return { from: current, pending: false };
}

export type ComposerLiveModelSource = {
	provider?: string;
	modelId?: string;
	modelName?: string;
};

/**
 * 底栏/选择器当前模型：会话保存的用户选择优先。
 *
 * 已有会话取 `SessionRecord.model`，尚未创建会话的引导页取 `fallback`。pi 的运行时
 * 状态是执行态（get_state），不能参与名称或当前选择的决策；这样 Agent 启动前后都展示
 * 同一份本地名称快照。
 *
 * DSH 例外：`runtime` 是 host 会话投影 `modelSelection.next ?? lastUsed`（宿主持久化的
 * 会话级选择，不是执行态）。历史/外部 DSH 会话的 catalog 可能从未写过 model，此时若直接
 * 落到部署默认（全局单值），会把「别的会话的选择」显示成本会话的模型。因此 DSH 调用方
 * 在 record 缺 model 时传 runtime 兜底；pi 调用方不得传。
 */
export function resolveComposerLiveModel(input: { record?: { provider?: string; modelId?: string; modelName?: string }; runtime?: ComposerLiveModelSource; fallback?: ComposerLiveModelSource }): ModelPendingRef {
	const record = input.record?.provider && input.record.modelId ? input.record : undefined;
	const runtime = input.runtime?.provider && input.runtime.modelId ? input.runtime : undefined;
	const source = record ?? runtime ?? input.fallback;
	return {
		provider: source?.provider ?? "",
		modelId: source?.modelId ?? "",
		modelName: resolveModelDisplayName(source?.modelName, source?.modelId ?? ""),
	};
}

/**
 * 引导页（无 record、未启动 Agent）的默认模型展示决策。
 *
 * 不变量：必须与主进程 `resolveLaunchDefaultOptions` 的来源次序一致
 * （点选 welcomeModel > 显式默认 > enabledModels > 上次使用），否则「底栏/选择器
 * 显示的默认」与「首次发送真实套用的默认」会分叉——用户表现为「页面切了但发送后
 * 变回去」。历史上展示层只建模了「显式默认」一级（defaultModelConfigured 为 true
 * 时直接屏蔽点选），而创建解析有四级来源，这就是「配了默认模型就切不动」的根因。
 *
 * 收拢为单一函数的原因：该规则曾在 ComposerPickerHost 与 ComposerComponents 各写
 * 一份（两份都带同一个闸门），任何一侧改动都容易漏改另一侧。
 *
 * 两种后端都是「点选 > 默认」（issue #253）：
 * - pi：点选是 welcomeModel，默认是 launchDefaults 的折叠结果（显式默认 / 切换列表 /
 *   上次使用）。
 * - DSH：点选来自独立的 WELCOME_DSH_MODEL_KEY，默认是部署默认（settings.yaml 的
 *   agent-default-model）。历史上 dsh 分支直接返回 defaultModel，把点选丢掉了——
 *   理由是「DSH 模型由部署默认决定」，但 host 提供 sessions.selectModel（PiDeck 的
 *   DshAgentManager.setModel 就在用），运行中也能换模型，所以引导页点选同样有意义。
 *   真正需要隔离的只是「pi 的偏好不能泄漏到 DSH」，这件事由存储键分开保证，
 *   不需要在展示层把两种后端的点选一起丢掉。
 */
export function resolveGuideDisplayModel(input: {
	isDsh: boolean;
	/** 引导页点选（已经过 isWelcomeModelLost 校验，失效时为 undefined）。两种后端各自传入对应存储的偏好。 */
	welcomeModel?: { provider: string; modelId: string; modelName?: string };
	/** 主进程解析出的预选默认（pi 的 launchDefaults 折叠结果 / DSH 的部署默认）。 */
	defaultModel?: ComposerLiveModelSource;
}): ComposerLiveModelSource | undefined {
	return input.welcomeModel ?? input.defaultModel;
}
