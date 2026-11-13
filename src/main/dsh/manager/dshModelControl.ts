import { isDshPermissionPreset } from "../../../shared/types/agent";
import type { DshPermissionPreset } from "../../../shared/types";
import type { DshRemoteClient } from "../dshRemoteClient";
import type { DshAgentRuntime } from "./dshAgentRuntime";

/**
 * 模型与权限选择的宿主出口：会话 map 与「上一回合是否 idle」的串行化留在
 * DshAgentManager，模块只经这里取 runtime / 客户端与等待 idle。
 */
export type DshModelControlHost = {
	getRuntime(agentId: string): DshAgentRuntime;
	requireClient(): DshRemoteClient;
	waitForIdle(agentId: string): Promise<void>;
};

export async function setDshModel(host: DshModelControlHost, agentId: string, provider: string, modelId: string): Promise<unknown> {
	const runtime = host.getRuntime(agentId);
	// DSH 0.2 的 model selection 是会话级持久化选择：运行中切换时，
	// 已经发出的 provider request 保持原配置，后续 step 读取新的完整选择。
	// 若某类后端/会话不接受该操作，让 selectModel 返回 busy，由上层排队到下一轮。
	const client = host.requireClient();
	// DSH 官方语义：换模型 = 提交一整个新选择（provider/model/reasoningEffort），
	// 思考档位随目标模型走，而不是把旧模型的 thinkingLevel 带过去。
	const selected = await selectModelWithCatalogEffort(client, runtime, provider, modelId);
	if (!selected.result.ok) {
		throw selectModelError(selected.result.error, provider, modelId);
	}
	runtime.model = selected.result.value.selected;
	runtime.modelRoutable = true;
	// host 返回的 reasoningEffort 才是真实生效档位；同步内存，避免底栏显示旧档位。
	runtime.thinkingLevel = selected.result.value.selected.reasoningEffort;
	return selected.result.value;
}

/**
 * 按 DSH 官方模型选择语义执行 selectModel：换模型时优先使用目标模型
 * 声明的 reasoning.defaultEffort；目标模型没有声明时省略 reasoningEffort，
 * 由 provider 使用自己的默认行为。绝不沿用旧模型的 thinkingLevel，
 * 避免新模型不支持旧档位导致“模型切不过去”。
 */
async function selectModelWithCatalogEffort(client: DshRemoteClient, runtime: DshAgentRuntime, provider: string, modelId: string) {
	let reasoningEffort: string | undefined;
	try {
		const catalog = await client.sessionsModelCatalog();
		if (catalog.result.ok) {
			const group = catalog.result.value.groups.find((item) => item.id === provider);
			const model = group?.models.find((item) => item.id === modelId);
			reasoningEffort = model?.reasoning?.defaultEffort;
		}
	} catch {
		// 目录读取失败不阻塞换模型：省略档位让 host 按 provider 默认处理。
	}
	return client.sessionsSelectModel({
		sessionId: runtime.sessionId,
		provider,
		model: modelId,
		...(reasoningEffort ? { reasoningEffort } : {}),
	});
}

export async function setDshThinking(host: DshModelControlHost, agentId: string, level: string): Promise<void> {
	// DSH 的思考档走 selectModel.reasoningEffort，没有独立 RPC。
	const runtime = host.getRuntime(agentId);
	const selected = runtime.model;
	if (!selected) {
		// 没有当前模型时 DSH 无法把档位落到 host；只作为草稿偏好由 catalog 保存，
		// 不写入 runtime.thinkingLevel，否则后续换模型会误把它带过去。
		return;
	}
	// 不在 PiDeck 侧预先拒绝运行中的回合：如果 host 支持动态切换，
	// 当前回合可以直接使用；如果 host 不支持，由 selectModel 返回 busy/error。
	const previous = runtime.thinkingLevel;
	runtime.thinkingLevel = level;
	const client = host.requireClient();
	try {
		const updated = await client.sessionsSelectModel({
			sessionId: runtime.sessionId,
			provider: selected.provider,
			model: selected.model,
			reasoningEffort: level,
		});
		if (updated.result.ok) {
			runtime.model = {
				provider: updated.result.value.selected.provider,
				model: updated.result.value.selected.model,
			};
			runtime.modelRoutable = true;
			runtime.thinkingLevel = updated.result.value.selected.reasoningEffort ?? level;
		} else {
			runtime.thinkingLevel = previous;
			throw selectModelError(updated.result.error, selected.provider, selected.model);
		}
	} catch (error) {
		runtime.thinkingLevel = previous;
		throw error;
	}
}

export async function setDshPermission(host: DshModelControlHost, agentId: string, preset: string): Promise<unknown> {
	if (!isDshPermissionPreset(preset)) {
		throw new Error(`Unsupported DSH permission preset: ${preset}`);
	}
	// DSH 权限预设切换走 /permission 命令（host 侧 slash 桥在 agent/pre-step
	// 拦截执行）：sandbox 模式 + approval 策略随命令立即生效，permission/preset
	// 等事件经 mux 折叠进 runtime state。命令消息不进模型、不上时间线。
	const runtime = host.getRuntime(agentId);
	const client = host.requireClient();
	// 与 sendPrompt 同一串行化约束：命令回合运行中不允许再 splice 消息
	// （reject 路径会滞留回合内到达的 followup，见 sendPrompt 注释）。
	await host.waitForIdle(agentId);
	// The host-apiproxy client exposes sessions.prompt, not the browser runtime's
	// high-level session.command API. The refreshed host-side slash bridge consumes
	// this control message before model dispatch, so it never becomes a timeline item.
	const sent = await client.sessionsPrompt({
		sessionId: runtime.sessionId,
		mode: "queue",
		content: [{ type: "text", text: `/permission ${preset}` }],
	});
	if (!sent.result.ok) {
		throw new Error(`dsh /permission failed: ${JSON.stringify(sent.result.error)}`);
	}
	// Prompt admission only means the command reached DSH. Wait for the durable
	// permission/preset projection before reporting success; otherwise the UI can
	// persist a restricted preset while the host is still using the old policy.
	const applied = await waitForPermissionPreset(runtime, preset);
	if (!applied) {
		throw new Error(`dsh /permission was accepted but preset did not become active: ${preset}`);
	}
	return { accepted: true, preset };
}

/** Wait for the host event fold rather than guessing from prompt acceptance. */
async function waitForPermissionPreset(runtime: DshAgentRuntime, preset: DshPermissionPreset, timeoutMs = 5_000): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (runtime.permissionPreset === preset) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	return runtime.permissionPreset === preset;
}

/** 把 host selectModel 错误收成 commandFailure 能识别的文案。 */
function selectModelError(error: unknown, _provider: string, _modelId: string): Error {
	const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
	const lower = `${code} ${JSON.stringify(error)}`.toLowerCase();
	if (lower.includes("busy") || lower.includes("in progress")) {
		return new Error(`dsh selectModel busy: ${JSON.stringify(error)}`);
	}
	// DSH 会把档位错误（如 reasoning effort 不被目标模型支持）折叠成
	// model-unavailable：保留原始 error.message（缺失时 JSON 兜底），
	// 不转译成笼统的 Model not found，真实拒绝原因才能透传给用户。
	if (lower.includes("model-unavailable") || lower.includes("unavailable")) {
		const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
		return new Error(message || JSON.stringify(error));
	}
	return new Error(`dsh selectModel failed: ${JSON.stringify(error)}`);
}
