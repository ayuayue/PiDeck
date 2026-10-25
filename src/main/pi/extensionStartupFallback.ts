/**
 * 扩展导致 pi RPC 起不来时的启动回退策略。
 *
 * 背景：内置扩展依赖 pi 自带的 @earendil-works/*。全局 pi 残缺时，
 * `--extension` 加载失败会让进程 exit 1，用户体感是「消息发不出去」。
 * 桌面端在首次启动失败后用 --no-extensions 再试一次，让会话先能用。
 */

export type ExtensionFallbackDecisionInput = {
	/** 用户或上次回退已经开了 --no-extensions，再试没有意义。 */
	alreadyNoExtensions: boolean;
	stderr?: string;
	errorMessage?: string;
	exitCode?: number | null;
	/**
	 * 进程仍在跑：多半是 get_state 超时/慢启动，而不是扩展把进程打死。
	 * 这时杀进程改无扩展会误伤，必须跳过。
	 */
	processStillRunning?: boolean;
	/**
	 * spawn 阶段就失败（进程从未起来，对应 PiProcess diagnostics.spawnFailed）。
	 * 这类失败与「加载了哪些扩展」毫无关系（Node 只发 error、不发 exit，pid 都没拿到），
	 * 重试 --no-extensions 只会原样再失败一次，还把用户引向错误的排查方向。
	 */
	spawnFailed?: boolean;
};

/**
 * 回退决策：retry 决定是否用 --no-extensions 再启动一次；
 * skipReason 是人话原因（retry 为 true 时为 null），用于诊断卡解释「为什么没自动回退」——
 * 用户记忆中「启动失败会自动禁用扩展重试」，不解释清楚就会被当成没生效。
 */
export type ExtensionFallbackDecision = {
	retry: boolean;
	skipReason: string | null;
};

/**
 * 是否值得用 --no-extensions 再启动一次，以及不重试时的原因。
 * 单一判定源：shouldRetryWithoutExtensions / describeExtensionFallbackSkip 都由它派生，
 * 避免「决策与解释」两条分支各自漂移。
 *
 * 不重试：已禁用扩展、进程还活着（超时）、spawn 阶段就失败、pi 本体不存在、
 * WSL 不可用。
 * 重试：明确扩展加载失败，或进程已非 0 退出 / 报 pi exited。
 */
export function decideExtensionFallback(input: ExtensionFallbackDecisionInput): ExtensionFallbackDecision {
	const text = `${input.stderr ?? ""}\n${input.errorMessage ?? ""}`;
	const spawnLikeFailure = input.spawnFailed === true || (/\bENOENT\b/.test(text) && /spawn/i.test(text));

	if (input.alreadyNoExtensions) {
		return { retry: false, skipReason: "当前启动已禁用扩展（设置里的诊断开关），无需再回退。" };
	}
	if (input.processStillRunning) {
		return {
			retry: false,
			skipReason: "pi 进程仍在运行（启动等待超时，而非进程被打死）：杀进程改无扩展会误伤慢启动，故不自动回退。",
		};
	}
	if (spawnLikeFailure) {
		return {
			retry: false,
			skipReason: "pi 进程从未启动（spawn 阶段失败），与加载了哪些扩展无关，回退 --no-extensions 也会同样失败。",
		};
	}
	if (/WSL distribution is unavailable/i.test(text)) {
		return { retry: false, skipReason: "WSL 发行版不可用，回退禁用扩展无法解决。" };
	}
	if (/Failed to load extension/i.test(text)) return { retry: true, skipReason: null };
	if (/Cannot find module/.test(text) && /extension/i.test(text)) return { retry: true, skipReason: null };
	if (typeof input.exitCode === "number" && input.exitCode !== 0) return { retry: true, skipReason: null };
	if (/pi exited\s*:/i.test(text)) return { retry: true, skipReason: null };
	return { retry: false, skipReason: null };
}

/**
 * 本次运行「扩展被禁用」的成因：
 * - setting：设置 → 开发设置 的「禁用扩展启动」开关为开（每个新会话都会复现，能力长期缺失的根源）；
 * - fallback：本次启动失败后自动回退（只作用于本次运行时，不写入设置）。
 */
export type DisabledExtensionsReason = "setting" | "fallback";

/**
 * 判定本次启动为何没有加载扩展；扩展正常加载时返回 null。
 * 设置开关优先：它是会被后续所有会话继承的持久成因，用户最需要被提醒的就是它；
 * 两者理论上互斥（设置已开时 decideExtensionFallback 不会再回退），同时为真时按设置归属更贴近用户可操作项。
 */
export function resolveDisabledExtensionsReason(input: { settingDisabled: boolean; fallbackFromExtensions: boolean }): DisabledExtensionsReason | null {
	if (input.settingDisabled) return "setting";
	if (input.fallbackFromExtensions) return "fallback";
	return null;
}

/**
 * 禁用扩展时给用户的文案与可执行动作。
 * 诊断卡（会话时间线，mainProcessCopy 的 diagnostic.*）与 toast（rendererCopy 的 notice.*）
 * 共用同一份成因判定，避免「卡片说没持久化、提示说去设置关掉」这类口径漂移。
 */
export type DisabledExtensionsCopy = {
	/** 时间线诊断卡的 i18n key 与兜底文案（zh；渲染层按当前语言取译）。 */
	diagnosticKey: string;
	diagnosticFallback: string;
	/** toast 的 i18n key 与兜底文案（zh）。 */
	noticeKey: string;
	noticeFallback: string;
	/**
	 * toast 停留时长：需要用户读完并决定要不要去设置，比普通瞬时反馈（2.5s）长；
	 * 仍不设常驻，避免每次启动都留一条关不掉的提示。
	 */
	noticeDurationMs: number;
	/**
	 * 需要引导用户去「设置 → 开发设置」时的动作 id（渲染层解析成导航，主进程不持有 UI 路径）。
	 * 仅设置成因带动作：回退是本次运行的临时状态，去设置并不能解决坏扩展。
	 */
	noticeAction?: "openDevExtensionsSettings";
};

/** 成因 → 文案/动作映射（纯查表，便于单测与后续新增成因）。 */
export function resolveDisabledExtensionsCopy(reason: DisabledExtensionsReason): DisabledExtensionsCopy {
	if (reason === "fallback") {
		return {
			diagnosticKey: "diagnostic.extensionsDisabledFallback",
			diagnosticFallback: "扩展加载失败，本次运行已临时禁用扩展（不写入设置，「禁用扩展启动」开关保持原样），下次启动会重新尝试加载扩展。" + "可在本会话把下面的错误信息发给 AI，协助排查扩展问题。",
			noticeKey: "notice.extensionsDisabledFallback",
			noticeFallback: "扩展加载失败，本次运行已临时禁用扩展（不会写入设置）。可把本会话的错误详情发给 AI 排查扩展问题。",
			noticeDurationMs: 10_000,
		};
	}
	return {
		diagnosticKey: "diagnostic.extensionsDisabledBySetting",
		diagnosticFallback: "本次启动未加载任何扩展：设置 → 开发设置 的「禁用扩展启动」处于开启状态，todo/plan/ask 等扩展能力不可用。" + "如非排查扩展问题需要，请关闭该开关后重启会话。",
		noticeKey: "notice.extensionsDisabledBySetting",
		noticeFallback: "「禁用扩展启动」已开启：本次会话未加载任何扩展，todo/plan/ask 等能力不可用。不需要排查扩展时请去设置关闭该开关。",
		noticeDurationMs: 12_000,
		noticeAction: "openDevExtensionsSettings",
	};
}

/** 是否值得用 --no-extensions 再启动一次（decideExtensionFallback 的布尔视图）。 */
export function shouldRetryWithoutExtensions(input: ExtensionFallbackDecisionInput): boolean {
	return decideExtensionFallback(input).retry;
}

/** 未回退时的人话原因（会回退或无法归因时返回 null）。 */
export function describeExtensionFallbackSkip(input: ExtensionFallbackDecisionInput): string | null {
	return decideExtensionFallback(input).skipReason;
}

/** 从 stderr 抽出扩展加载失败行，方便用户把诊断贴进聊天让 AI 分析。 */
export function extractExtensionLoadHints(stderr: string): string[] {
	const lines = stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const hints: string[] = [];
	for (const line of lines) {
		if (/Failed to load extension/i.test(line) || /Cannot find module/.test(line)) {
			hints.push(line);
		}
	}
	return [...new Set(hints)].slice(0, 8);
}

/** 回退成功后写入系统消息 debugDetails 的原文（不走 i18n，给 AI/Issue 看）。 */
export function formatExtensionFallbackDebug(input: { rawMessage: string; stderr: string; exitCode?: number | null }): string {
	const lines: string[] = [];
	if (input.exitCode !== null && input.exitCode !== undefined) {
		lines.push(`First start exit code: ${input.exitCode}`);
	}
	if (input.rawMessage.trim()) {
		lines.push(input.rawMessage.trim());
	}
	const hints = extractExtensionLoadHints(input.stderr);
	if (hints.length > 0) {
		lines.push("Extension load errors:");
		lines.push(...hints);
	} else {
		const stderrText = input.stderr.trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? `…${stderrText.slice(-600)}` : stderrText;
			lines.push(`Process stderr:\n${snippet}`);
		}
	}
	return lines.join("\n");
}
