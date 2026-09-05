/**
 * PiDeck Request Size Recovery Extension
 *
 * 背景：会话历史（完整请求体）超过中转网关的字节上限（如 nginx
 * client_max_body_size）时，网关通常返回 413，也可能通过 400 或自定义错误
 * 文案报告同一问题。此时后续请求与当前模型发起的压缩请求都可能失败。
 *
 * 方案（与上游维护者建议一致，见 ayuayue/PiDeck#185）：识别明确的请求体
 * 大小超限错误后弹确认框，
 * 用户同意则「用指定模型压缩」——临时切换到请求上限更大的模型执行压缩
 * （AgentSession.compact 的摘要请求走当前会话模型），完成后自动切回原模型。
 * 会话缩小后用户重新发送刚才失败的请求即可，死锁解除。
 *
 * 设计约束：
 * - 纯扩展实现，不改 pi 核心逻辑
 * - 默认零影响：仅 assistant + stopReason=error + 明确的请求体超限信号 +
 *   hasUI（TUI/RPC）+ 不在冷却期才弹一次 confirm；无 UI 的模式完全静默
 * - 候选模型只含已配置密钥的（hasConfiguredAuth），排除当前模型；
 *   label 用 `provider/modelId`（解析安全，不依赖显示名）
 * - RPC 模式 confirm 的取消会解析为 false（与「否」同义）；select 的取消
 *   可能是 null/空串或框架层抛错（见 pi-deck-ask-question），两种都按放弃处理
 * - 弹框后未成功跑压缩（拒绝/取消/切模型失败/无候选）进入 10 分钟冷却，
 *   防止 pi 重试循环里的连续 413 刷屏弹框；压缩真正跑过（无论成败）则
 *   重置冷却，允许下一次 413 再次提议
 * - 恢复期间（切模型→压缩→切回）recoveryActive 置位，后续错误不再触发
 * - 用户在恢复期间手动切模型（model_select）：收尾时若当前模型已不是
 *   临时模型则不切回，尊重用户操作
 *
 * 与 pi-deck-retry-no-body 的分工：`413 status code (no body)` 仍由现有扩展
 * 按瞬态故障处理；本扩展只处理状态码或文案明确表明请求体过大的错误，避免
 * 同一次失败同时进入重试与压缩恢复流程。
 *
 * @packageDocumentation
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 纯函数：请求体大小超限识别与候选模型构建（不依赖 pi API，便于独立测试）
// ---------------------------------------------------------------------------

/**
 * 判断错误信息是否明确表示请求体超过网关字节上限。
 *
 * 413 本身即表示 Content Too Large，但明确排除 `(no body)`：该形态在部分
 * 中转网关中属于瞬态故障，由 pi-deck-retry-no-body 负责。没有 413 时，只匹配
 * request/payload/body/client_max_body_size 等明确的请求体大小语义。
 * 实测形态（pi 0.84.4 经 formatProviderError 组合）：
 * - `413 Payload Too Large: <html>…` —— nginx 错误页 body
 * - `413 Request Entity Too Large` —— IIS 风格
 * - `400 Bad Request: request body too large` —— 非标准 400 形态
 * - `client intended to send too large body` —— nginx 错误日志形态
 *
 * @param errorMessage - assistant 消息的 errorMessage 字段
 * @returns 是否为请求体大小超限错误
 */
const REQUEST_SIZE_LIMIT_PATTERNS: RegExp[] = [
	/\b(?:request entity|payload|request body|request content)\s+too\s+large\b/i,
	/\bclient intended to send too large body\b/i,
	/\bclient_max_body_size\b/i,
	/\bmaximum (?:request body|payload|request content) size (?:exceeded|limit)\b/i,
	/\b(?:request body|payload|request content) size exceeds? (?:the )?(?:maximum|limit)\b/i,
	/\brequest size exceeds? (?:the )?limit(?: of)? \d+(?:\.\d+)?\s*(?:bytes?|kb|mb|gb|kib|mib|gib)\b/i,
];

const NO_BODY_RESPONSE_PATTERN =
	/(?:\(no body\)|no body\s*$|empty\s+response\s+body|no\s+response\s+body)/i;
const TOKEN_LIMIT_PATTERN =
	/\b(?:tokens?|context\s+(?:window|length)|maximum\s+context|prompt\s+(?:is\s+)?too\s+long)\b/i;
const HTTP_413_PATTERN =
	/(?:^\s*413(?:\s*$|\s*[:(-]|\s+(?:payload|request|content|status|error|response|entity)\b)|\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|response(?:\s+status)?|error\s+code)\s*[:=]?\s*413\b|\(\s*413\s*\)\s*:)/i;

export function isRequestSizeLimitError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (NO_BODY_RESPONSE_PATTERN.test(errorMessage)) return false;
	if (TOKEN_LIMIT_PATTERN.test(errorMessage)) return false;
	if (HTTP_413_PATTERN.test(errorMessage)) return true;
	return REQUEST_SIZE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/** 候选模型输入（从 ModelRegistry 摘取的测试友好子集）。 */
export interface RecoveryModelCandidate {
	provider: string;
	modelId: string;
	/** 该模型 provider 是否已配置密钥（hasConfiguredAuth）。 */
	authenticated: boolean;
}

/** 候选模型选项（label 即选项文本与唯一键）。 */
export interface RecoveryModelOption {
	provider: string;
	modelId: string;
	label: string;
}

/** 稳定模型唯一键：`provider/modelId`（provider 不含 `/`，modelId 可包含）。 */
export function modelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** 尝试切回恢复流程开始前的模型；不需要恢复时返回 undefined。 */
export async function attemptModelRestore<Model>(params: {
	currentModel: { provider: string; id: string } | undefined;
	temporaryModelKey: string | undefined;
	originalModelKey: string | undefined;
	findModel: (provider: string, modelId: string) => Model | undefined;
	setModel: (model: Model) => Promise<boolean>;
}): Promise<boolean | undefined> {
	const { currentModel, temporaryModelKey, originalModelKey, findModel, setModel } = params;
	if (!currentModel || !temporaryModelKey || !originalModelKey) return undefined;
	if (modelKey(currentModel.provider, currentModel.id) !== temporaryModelKey) return undefined;

	const separator = originalModelKey.indexOf("/");
	if (separator < 1) return false;
	const original = findModel(
		originalModelKey.slice(0, separator),
		originalModelKey.slice(separator + 1),
	);
	if (!original) return false;
	try {
		return await setModel(original);
	} catch {
		return false;
	}
}

/**
 * 从注册表摘取「换模型压缩」的候选列表。
 *
 * 规则：
 * - 排除未配置密钥的模型（切过去 setModel 也会返回 false）
 * - 排除当前模型（就是它 413 的）
 * - 去重（同一 provider/modelId 不出现两次）
 * - label 用 `provider/modelId`：解析安全、不依赖显示名
 * - 按 label 字典序排序，保证弹框顺序稳定
 *
 * @param candidates - 从注册表摘取的模型列表
 * @param current - 当前模型（将被排除），可为 undefined
 * @returns 排序后的候选列表
 */
export function buildRecoveryModelOptions(
	candidates: readonly RecoveryModelCandidate[],
	current: { provider: string; modelId: string } | undefined,
): RecoveryModelOption[] {
	const options: RecoveryModelOption[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.authenticated) continue;
		if (current && candidate.provider === current.provider && candidate.modelId === current.modelId) continue;
		const label = modelKey(candidate.provider, candidate.modelId);
		if (seen.has(label)) continue;
		seen.add(label);
		options.push({ provider: candidate.provider, modelId: candidate.modelId, label });
	}
	options.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	return options;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

/** 弹框后未成功跑压缩时的冷却时长：防止重试循环里的连续 413 刷屏弹框。 */
const OFFER_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * PiDeck 内置扩展：请求体大小超限恢复（用指定模型压缩）。
 *
 * 挂载 `message_end` 事件，只处理 assistant + stopReason=error + 明确的请求体超限错误。
 * 流程：confirm → select 候选 → setModel（临时）→ ctx.compact（摘要请求
 * 走临时模型）→ setModel（切回原模型）→ 结果通知。
 */
export default function (pi: ExtensionAPI): void {
	let dialogPending = false; // 确认框已弹出未关闭
	let recoveryActive = false; // 恢复进行中（切模型→压缩→切回）
	let offerCooldownUntil = 0; // 早于该时间戳不再弹框
	let tempModelKey: string | undefined; // 临时压缩模型唯一键
	let originalModelKey: string | undefined; // 原模型唯一键

	const setCooldown = (): void => {
		offerCooldownUntil = Date.now() + OFFER_COOLDOWN_MS;
	};

	const notice = (content: string): void => {
		pi.sendMessage(
			{
				customType: "pi-deck-request-size-recovery",
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
	};

	/** 收尾：按需切回原模型 → 发结果通知 → 重置冷却（压缩已真正跑过）。 */
	async function finish(ctx: ExtensionContext, ok: boolean, failureDetail?: string): Promise<void> {
		const tempKey = tempModelKey;
		const restoreKey = originalModelKey;
		tempModelKey = undefined;
		originalModelKey = undefined;
		recoveryActive = false;

		// 仅当当前模型仍是临时压缩模型才切回：
		// 用户在恢复期间手动切了模型，尊重其操作。
		let restoreNote = "";
		const restored = await attemptModelRestore({
			currentModel: ctx.model,
			temporaryModelKey: tempKey,
			originalModelKey: restoreKey,
			findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
			setModel: (model) => pi.setModel(model),
		});
		if (restored !== undefined) {
			restoreNote = restored ? "已切回原模型。" : "切回原模型失败，请手动选择。";
		}

		if (ok) {
			notice(`请求体超限恢复：压缩完成。${restoreNote}会话已缩小，请重新发送刚才失败的请求。`);
		} else {
			notice(`请求体超限恢复：压缩失败${failureDetail ? `（${failureDetail}）` : ""}。${restoreNote}可稍后重试，或新建会话。`);
		}
		// 压缩真正跑过，重置冷却：若下一个请求仍 413，允许再次提议（或换别的模型）
		offerCooldownUntil = 0;
	}

	/** 执行一次完整恢复：确认 → 选择 → 切模型 → 压缩。 */
	async function runRecovery(ctx: ExtensionContext): Promise<void> {
		let confirmed = false;
		try {
			confirmed = await ctx.ui.confirm(
				"请求体超过网关上限",
				"会话历史太大，网关拒绝接收，当前模型压缩也可能超过同一上限。\n临时切换到请求上限更大的模型执行压缩，完成后自动切回原模型。继续吗？",
			);
		} catch {
			confirmed = false; // RPC 模式取消可能由框架层抛出，按「否」处理
		}
		if (!confirmed) {
			setCooldown();
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const options = buildRecoveryModelOptions(
			available.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				authenticated: ctx.modelRegistry.hasConfiguredAuth(model),
			})),
			ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
		);

		if (options.length === 0) {
			setCooldown();
			notice("请求体超限恢复：没有其它已配置密钥的模型，无法换模型压缩。请新建会话，或为其它模型配置 API key。");
			return;
		}

		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				"选择用于压缩的临时模型（按 provider/modelId 列出）",
				options.map((option) => option.label),
			);
		} catch {
			choice = undefined;
		}
		// RPC 模式取消可能是 null/空串或抛错（见 pi-deck-ask-question），按放弃处理
		if (choice == null || choice === "") {
			setCooldown();
			return;
		}
		const option = options.find((candidate) => candidate.label === choice);
		if (!option) {
			setCooldown();
			return;
		}

		const model = ctx.modelRegistry.find(option.provider, option.modelId);
		if (!model) {
			setCooldown();
			notice(`请求体超限恢复：${option.label} 不在模型注册表中，已取消。`);
			return;
		}

		// 切换前记录原模型（ctx.model 的 getter 是实时的，setModel 之后已是新模型）
		const originalKey = ctx.model ? modelKey(ctx.model.provider, ctx.model.id) : undefined;

		recoveryActive = true;
		tempModelKey = modelKey(model.provider, model.id);
		originalModelKey = originalKey;
		const switched = await pi.setModel(model);
		if (!switched) {
			recoveryActive = false;
			tempModelKey = undefined;
			originalModelKey = undefined;
			setCooldown();
			notice(`请求体超限恢复：切换到 ${option.label} 失败。`);
			return;
		}

		// 压缩摘要请求走当前会话模型，此时即临时压缩模型
		ctx.compact({
			onComplete: () => {
				void finish(ctx, true);
			},
			onError: (error) => {
				void finish(ctx, false, error.message);
			},
		});
		// 注意：runRecovery 在此返回时恢复仍在进行（recoveryActive 由 finish 清除）。
		// 外层 finally 只清 dialogPending，两者独立。
	}

	pi.on("message_end", (event, ctx) => {
		// 只处理 assistant 的错误消息（user/toolResult/custom 消息直接透传）
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (!message.errorMessage) return;
		if (!isRequestSizeLimitError(message.errorMessage)) return;

		// 防重入 + 无 UI 模式 + 冷却期
		if (dialogPending || recoveryActive) return;
		if (!ctx.hasUI) return;
		if (Date.now() < offerCooldownUntil) return;

		dialogPending = true;
		void (async () => {
			try {
				await runRecovery(ctx);
			} catch {
				// 意外异常兜底：若已切换模型则切回原模型，重置状态并进入冷却，
				// 防止同一路径立即再次弹框
				await attemptModelRestore({
					currentModel: ctx.model,
					temporaryModelKey: tempModelKey,
					originalModelKey,
					findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
					setModel: (model) => pi.setModel(model),
				});
				recoveryActive = false;
				tempModelKey = undefined;
				originalModelKey = undefined;
				setCooldown();
			} finally {
				dialogPending = false;
			}
		})();
	});
}
