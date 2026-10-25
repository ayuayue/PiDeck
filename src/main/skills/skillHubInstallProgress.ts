/**
 * SkillHub 安装输出解析（纯函数，可单测）。
 *
 * 背景：`npx skills add` 一次冷启动实测约 30s（npm 拉 cli → git clone 仓库 → 写技能目录），
 * 旧实现用 execFile，只在结束时拿到 exit code，界面上就是一个转圈按钮——既没有进度，
 * 失败时也只把 stderr（npm warn）当原因，用户看到的「像卡死」有一半来自这里。
 * 本模块把原始输出流翻译成「阶段 + 百分比」，供主进程节流后推给渲染层。
 *
 * 为什么同时按 \n 和 \r 切分：npm 进度条与 git 的 "Receiving objects: 45%" 都用 \r 原地刷新，
 * 只按 \n 切分会把整段进度憋到进程结束才出现。
 */

import type { SkillHubInstallPhase } from "../../shared/types/skills";

// 阶段枚举与 IPC 事件载荷共用同一份定义（shared/types/skills.ts），避免两侧漂移。
export type { SkillHubInstallPhase };

export interface SkillHubInstallProgressUpdate {
	phase: SkillHubInstallPhase;
	/** 最近一条有意义的原始输出（已去 ANSI/旋转符），用于界面副标题与悬浮提示 */
	detail: string;
	/** 从 git/npm 进度行解析出的百分比（0-100），解析不到时不带 */
	percent?: number;
}

export interface SkillHubInstallProgressParser {
	/** 喂入一段原始输出，返回本次需要上报的进度（被节流/无新信息时为 null） */
	push(chunk: string): SkillHubInstallProgressUpdate | null;
	/** 当前最新状态（含被节流未上报的），失败兜底与日志用 */
	current(): SkillHubInstallProgressUpdate | null;
}

/** 两次上报之间的最小间隔：npm/git 进度刷新远快于此，不节流会把 IPC 打满 */
export const INSTALL_PROGRESS_MIN_INTERVAL_MS = 200;

/** 旋转符/箭头：CLI 用它们做 spinner 帧，去掉后同一行才不会反复触发上报 */
const SPINNER_PREFIX_RE = /^[\s\u2800-\u28FF\u25A0-\u25FF\u2B00-\u2BFF\u00B7\u2022✳✶✷✸✹✺|\-—]+/u;
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** 任何 CSI 序列（非颜色/样式）都等价于「同一行原地重画」，要当成 \r 处理 */
const CSI_RE = /\u001b\[([0-9;?]*)([A-Za-z])/g;

/**
 * 去掉 ANSI 并把「原地重画」转成段边界。
 * 实测 `npx skills add` 的 spinner 用 `\u001b[2K\u001b[1G` 重画同一行（不是 `\r`）：
 * 只去转义不切段，一屏的 spinner 帧会拼成「◒ Cloning…◐ Cloning…」推给界面。
 */
function normalizeRedraws(chunk: string): string {
	return chunk.replace(CSI_RE, (match, _params: string, final: string) => (final === "m" ? match : "\r"));
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

/** 阶段判定：按实测输出特征匹配，命中即切换（后到的规则优先级更高） */
function detectPhase(line: string): SkillHubInstallPhase | null {
	if (/Cloning (repository|into)|Receiving objects|Resolving deltas|Compressing objects|Enumerating objects|remote:|Downloading/i.test(line)) return "downloading";
	if (/^Installing |^Installed |Installing skill|Successfully installed|Installed \d+ skill|Writing |^Creating /i.test(line)) return "installing";
	if (/npm (warn|notice|info) exec|The following package was not found|being installed|^npm http/i.test(line)) return "preparing";
	return null;
}

/** 从进度行里取百分比（git/npm 都会打 `45%`），取不到返回 undefined */
function detectPercent(line: string): number | undefined {
	const match = /(\d{1,3})%/.exec(line);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
	return value;
}

/** 过滤纯噪声行：空行、纯符号行、进度条边框 */
function isNoise(line: string): boolean {
	if (!line) return true;
	return !/[\p{L}\p{N}]/u.test(line);
}

export function createInstallProgressParser(options?: { minIntervalMs?: number; now?: () => number }): SkillHubInstallProgressParser {
	const minIntervalMs = options?.minIntervalMs ?? INSTALL_PROGRESS_MIN_INTERVAL_MS;
	const now = options?.now ?? (() => Date.now());
	let buffer = "";
	/** 最新解析结果（可能因节流未上报），失败兜底与日志用 */
	let latest: SkillHubInstallProgressUpdate | null = null;
	/** 最近一次实际上报的进度（节流基准） */
	let emitted: SkillHubInstallProgressUpdate | null = null;
	let lastEmitAt = 0;

	const accept = (rawLine: string): SkillHubInstallProgressUpdate | null => {
		const line = stripAnsi(rawLine).replace(SPINNER_PREFIX_RE, "").trim();
		if (isNoise(line)) return null;
		const detected = detectPhase(line);
		const percent = detectPercent(line);
		const phase = detected ?? latest?.phase ?? "running";
		// 阶段未变、没有新百分比、文本也和上次一致 → 无新信息（spinner 反复刷同一句话时最常见）
		if (phase === latest?.phase && percent === undefined && line === latest.detail) return null;
		const update: SkillHubInstallProgressUpdate = { phase, detail: trimDetail(line) };
		// 百分比属于「阶段内进度」：git 的 Receiving objects 之后紧跟 Resolving deltas（无百分比行）时
		// 不能把进度倒回 0，沿用同阶段已解析到的数值。
		if (percent !== undefined) update.percent = percent;
		else if (latest && latest.phase === phase && latest.percent !== undefined) update.percent = latest.percent;
		latest = update;
		return update;
	};

	const shouldEmit = (update: SkillHubInstallProgressUpdate | null): SkillHubInstallProgressUpdate | null => {
		if (!update) return null;
		const timestamp = now();
		const phaseChanged = update.phase !== (emitted?.phase ?? "running");
		const percentMoved = update.percent !== undefined && update.percent !== emitted?.percent;
		// 阶段切换与百分比推进必须立即上报（用户感知的关键点），其余按最小间隔节流。
		if (!phaseChanged && !percentMoved && timestamp - lastEmitAt < minIntervalMs) return null;
		lastEmitAt = timestamp;
		emitted = update;
		return update;
	};

	return {
		push(chunk: string): SkillHubInstallProgressUpdate | null {
			buffer += normalizeRedraws(chunk);
			const parts = buffer.split(/[\r\n\u0008]/);
			buffer = parts.pop() ?? "";
			let pending: SkillHubInstallProgressUpdate | null = null;
			for (const part of parts) {
				const update = accept(part);
				if (!update) continue;
				const reported = shouldEmit(update);
				if (reported) pending = reported;
			}
			return pending;
		},
		current(): SkillHubInstallProgressUpdate | null {
			return latest;
		},
	};
}

function trimDetail(line: string): string {
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 失败原因里的网络特征：用于附加「可能需要代理」的可执行提示（本地化文案由调用方注入） */
export function isNetworkFailure(text: string): boolean {
	return /unable to access|Could not resolve host|Connection was reset|Connection reset|ECONNRESET|ETIMEDOUT|ETIMEDOUT|timed out|TLS|network|ERR_SOCKET|proxy/i.test(text);
}

/**
 * 失败原因清洗：CLI 的真实报错打在 stdout（npm 的 warn/notice 才走 stderr），
 * 旧实现只看 stderr，于是「git clone 失败」被 npm 的三行告警盖住 —— 这里优先取 stdout 尾部，
 * 再退 stderr，最后退调用方给的兜底串（超时/退出码等）。
 */
export function cleanInstallOutput(input: { stdout: string; stderr: string; fallback: string; maxLength?: number }): string {
	const maxLength = input.maxLength ?? 300;
	const pick = (value: string): string => {
		const lines = value
			.split(/[\r\n]/)
			.map((line) => stripAnsi(line).replace(SPINNER_PREFIX_RE, "").trim())
			.filter((line) => !isNoise(line));
		return lines.slice(-3).join(" · ");
	};
	const stdoutTail = pick(input.stdout);
	const stderrTail = pick(input.stderr);
	const fallback = input.fallback.trim();
	const primary = stdoutTail || stderrTail;
	const combined = !primary ? fallback : !fallback || primary.includes(fallback) ? primary : `${fallback}: ${primary}`;
	return combined.length > maxLength ? `${combined.slice(0, maxLength)}…` : combined;
}

/** 只保留输出尾部，避免长安装输出把内存撑起来（失败原因只看尾部） */
export function keepTail(value: string, limit = 16 * 1024): string {
	return value.length <= limit ? value : value.slice(value.length - limit);
}
