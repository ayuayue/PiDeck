/**
 * DSH 权限预设的权威读取与写入等待（issue #548）。
 *
 * `/permission <preset>` 走 host 的 slash 桥；`@deepseek-ai/dsh-permission-presets` 的
 * apply 是幂等且静默的——sandbox/approval 已经等于目标值时一个事件都不 append，只记
 * `command/done {kind:"success"}`。PiDeck 之前只等 `permission/preset` 事件，于是：
 *   - 重启后 applyPreferences 重放同一预设 → 永远等不到事件 → 5s 超时；
 *   - 用户真实消息因此根本没发出去，会话表现为「每次发消息都失败」。
 *
 * 官方 `sessionsProjections` 的 `values.permissions.currentValue` 是由三个 knob 事件
 * 折叠出的权威视图（composition 默认值也参与），幂等 no-op 时它仍然正确。这里用它
 * 做两件事：写入前判断「已经是目标值」直接成功（不发注定产生 blocked 回合的命令），
 * 写入后作为事件折叠的兜底（事件丢失/投影延迟时仍能确认）。
 *
 * 纯读取 + 纯等待，不持有会话状态；失败一律返回 undefined / false，由调用方决定报错。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 最小客户端形状：只用到 sessionsProjections（第三方 wire，不引入 SDK 类型）。 */
type ProjectionReader = { sessionsProjections: (input: { sessionId: string }) => Promise<unknown> };

/** 读取会话当前权限预设；host 未组合权限服务、投影不可用或形状不符时返回 undefined。 */
export async function readDshPermissionPreset(client: ProjectionReader, sessionId: string): Promise<string | undefined> {
	try {
		const envelope = await client.sessionsProjections({ sessionId });
		if (!isRecord(envelope) || !isRecord(envelope.result) || envelope.result.ok !== true) return undefined;
		const value = envelope.result.value;
		const values = isRecord(value) ? value.values : undefined;
		const permissions = isRecord(values) ? values.permissions : undefined;
		const current = isRecord(permissions) ? permissions.currentValue : undefined;
		return typeof current === "string" && current.length > 0 ? current : undefined;
	} catch {
		// 投影读取是确认手段，不是必需通道：host 旧版/会话已关闭时按未知处理。
		return undefined;
	}
}

export type DshPermissionWaitOptions = {
	/** 运行态（事件折叠结果）；命中时直接成功，兜底确认后也回写这里。 */
	runtime: { permissionPreset?: string };
	preset: string;
	/** 官方投影读取（readDshPermissionPreset 的绑定版本）。 */
	probe: () => Promise<string | undefined>;
	timeoutMs?: number;
};

/**
 * 等待权限预设生效：事件折叠优先，投影按 250ms 节流兜底。
 * 超时仍以 runtime 的最终值判定（与旧实现同口径），不把「读不到投影」当成失败。
 */
export async function waitForDshPermissionPreset(options: DshPermissionWaitOptions): Promise<boolean> {
	const startedAt = Date.now();
	const timeoutMs = options.timeoutMs ?? 5_000;
	let nextProbeAt = 0;
	while (Date.now() - startedAt < timeoutMs) {
		if (options.runtime.permissionPreset === options.preset) return true;
		if (Date.now() >= nextProbeAt) {
			nextProbeAt = Date.now() + 250;
			if ((await options.probe()) === options.preset) {
				options.runtime.permissionPreset = options.preset;
				return true;
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	return options.runtime.permissionPreset === options.preset;
}
