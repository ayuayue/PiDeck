import type { FeedbackProjectContext, HealthCheckItem, HealthReport, HealthReportContext, HealthReportFormat, HealthStatus } from "../../../../shared/types";

/**
 * 诊断报告的三种输出形态纯函数。
 *
 * 为什么独立成纯模块：markdown/card/prompt 是「把体检数据翻译成可分享文本」的纯转换，
 * 不依赖 React/i18n/IPC，可以脱离渲染层直接单测——「报告里是否漏了某个字段 / 卡片
 * 是否太长」这类回归用测试锁定，比靠视觉检查可靠。
 *
 * 隐私承诺：入参 HealthReport 本身已脱敏（主进程最后一环），本模块不额外读写任何
 * 文件或配置，只做文本拼装。
 */

const STATUS_ICON: Record<HealthStatus, string> = {
	ok: "✅",
	warn: "⚠️",
	error: "❌",
	skipped: "➖",
};

const STATUS_LABEL: Record<HealthStatus, string> = {
	ok: "OK",
	warn: "WARN",
	error: "ERROR",
	skipped: "SKIP",
};

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "n/a";
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

function formatTime(ms: number): string {
	const date = new Date(ms);
	const pad = (v: number) => String(v).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 环境信息 → Markdown 清单。 */
function environmentLines(env: HealthReport["environment"]): string[] {
	const flags: string[] = [];
	if (env.flags.wslEnabled) flags.push("WSL on");
	if (env.flags.piProxyEnabled) flags.push(`pi proxy ${env.flags.piProxyConfigured ? "configured" : "unset"}`);
	if (env.flags.desktopProxyEnabled) flags.push("desktop proxy on");
	if (env.flags.chromiumSandbox) flags.push("chromium sandbox on");
	if (env.flags.developerDiagnostics) flags.push("dev diagnostics on");
	if (env.flags.webServiceEnabled) flags.push("web service on");
	if (env.flags.customPiPathConfigured) flags.push("custom pi path");
	const osLabel = env.platform === "win32" ? `Windows ${env.osVersion}` : env.platform === "darwin" ? `macOS ${env.osVersion}` : `${env.platform} ${env.osVersion}`;
	return [
		`- PiDeck ${env.appVersion} (${env.installMode})`,
		`- OS: ${osLabel} (${env.arch})`,
		`- Electron ${env.electronVersion} / Chrome ${env.chromeVersion} / Node ${env.nodeVersion}`,
		`- Locale: ${env.locale} · TZ: ${env.timezone}`,
		`- Data dir: ${env.userDataDir || "(masked)"}`,
		`- Mem: app ${formatBytes(env.appRssBytes)} RSS · system ${formatBytes(env.systemFreeMemoryBytes)} free / ${formatBytes(env.systemTotalMemoryBytes)}`,
		`- Disk (data dir): ${formatBytes(env.dataDirFreeBytes)} free`,
		`- pi: ${env.pi?.installed ? env.pi.version || "installed" : "NOT installed"}`,
		`- Flags: ${flags.length ? flags.join(", ") : "none"}`,
	];
}

/** 检查项 → Markdown 清单。 */
function checkLines(checks: HealthCheckItem[]): string[] {
	return checks.map((check) => {
		const status = `${STATUS_ICON[check.status]} ${STATUS_LABEL[check.status]}`;
		return `- ${status} · ${check.id}${check.detail ? ` — ${check.detail}` : ""}`;
	});
}

/** 最近报错 → Markdown 清单（条数上限避免失控；默认 150 条，保证「今天」的报错都在）。 */
function recentErrorLines(summary: HealthReport["logSummary"], limit = 150): string[] {
	const lines = summary.recent.slice(0, limit).map((line) => {
		const scope = line.scope ? ` [${line.scope}]` : "";
		return `- ${formatTime(line.time)} ${line.level.toUpperCase()}${scope}: ${line.message}`;
	});
	// 采集量超过展示上限时补一行说明，避免用户误以为日志只有这么多
	if (summary.recent.length > limit) {
		lines.push(`… 共 ${summary.recent.length} 条（完整列表见「导出日志包」）`);
	}
	return lines;
}

/** 日志统计行：总量 + 今日，让「今天的报错」一眼可见。 */
function logSummaryLine(summary: HealthReport["logSummary"]): string {
	const today = summary.todayError > 0 || summary.todayWarn > 0 ? ` · today ${summary.todayError} errors / ${summary.todayWarn} warns` : "";
	return `Total ${summary.total} · errors ${summary.error} · warns ${summary.warn} (last 7 days)${today}`;
}

/**
 * 生成 Markdown 完整报告：适合贴 GitHub Issue / 邮件 / 群文件。
 * 标签用英文，保证分享到英文环境也能读。
 */
export function formatMarkdown(report: HealthReport, context: HealthReportContext): string {
	const lines: string[] = [];
	lines.push(`# PiDeck Diagnostic Report`);
	lines.push("");
	lines.push(`Generated: ${formatTime(report.generatedAt)}`);
	lines.push("");
	lines.push(`## Description`);
	lines.push(context.description.trim() || "_（empty）_");
	if (context.steps.trim()) {
		lines.push("");
		lines.push(`### Repro steps`);
		lines.push(context.steps.trim());
	}
	lines.push("");
	lines.push(`## Health checks`);
	if (report.checks.length === 0) {
		lines.push("_no checks available_");
	} else {
		lines.push(...checkLines(report.checks));
	}
	lines.push("");
	lines.push(`## Environment`);
	lines.push(...environmentLines(report.environment));
	lines.push("");
	lines.push(`## Recent logs (${Math.min(150, report.logSummary.recent.length)} shown of ${report.logSummary.recent.length} collected)`);
	lines.push(logSummaryLine(report.logSummary));
	if (report.logSummary.recent.length === 0) {
		lines.push("_no recent errors/warnings_");
	} else {
		lines.push(...recentErrorLines(report.logSummary));
	}
	return lines.join("\n");
}

/**
 * 生成精简群消息卡片：一两屏能看完，适合直接发到用户群让支持者扫一眼。
 */
export function formatCard(report: HealthReport, context: HealthReportContext): string {
	const lines: string[] = [];
	lines.push(`📋 PiDeck 诊断 | ${report.environment.appVersion}`);
	lines.push("");
	const problem = context.description.trim().split("\n")[0].slice(0, 80);
	lines.push(`**问题**：${problem || "（未填写）"}`);
	lines.push("");
	if (report.checks.length > 0) {
		const first = report.checks.slice(0, 4);
		lines.push("**体检**：");
		lines.push(...checkLines(first));
		if (report.checks.length > 4) lines.push(`… 共 ${report.checks.length} 项`);
	}
	lines.push("");
	lines.push(`**环境**：${environmentLines(report.environment)[0]}`);
	const free = formatBytes(report.environment.dataDirFreeBytes);
	lines.push(`**磁盘余量**：${free} · **内存**：${formatBytes(report.environment.appRssBytes)} RSS`);
	if (report.logSummary.error > 0 || report.logSummary.warn > 0) {
		lines.push(`**近7天日志**：${report.logSummary.error} errors / ${report.logSummary.warn} warns`);
	}
	if (report.logSummary.todayError > 0 || report.logSummary.todayWarn > 0) {
		lines.push(`**今日**：${report.logSummary.todayError} errors / ${report.logSummary.todayWarn} warns`);
	}
	lines.push("");
	lines.push(`_由 PiDeck 生成 · ${formatTime(report.generatedAt)}_`);
	return lines.join("\n");
}

/**
 * 生成可复制给任意 AI 的分析提示词：角色设定 + 体检结果 + 报错摘要 + 项目上下文，
 * 用户粘贴给 ChatGPT/DeepSeek/群友即可让 AI 帮忙定位；也用于「新建会话分析」
 * 直接填进 PiDeck 新会话的输入框（此时 pi 会自动加载项目 AGENTS.md 与技能）。
 */
export function formatAiPrompt(report: HealthReport, context: HealthReportContext, projectContext?: FeedbackProjectContext): string {
	const lines: string[] = [];
	lines.push(`你是一名专业的桌面软件技术支持工程师。请根据下面的 PiDeck 诊断报告，判断可能的问题根因，并给出**分步骤、可执行**的排查和修复建议。`);
	lines.push(`如果信息不足，请明确说明你还缺哪些信息，而不是猜测。涉及修改配置文件时，提醒先备份，且不要泄露或要求提供任何密钥/Token。`);
	lines.push("");
	lines.push(`## 用户描述`);
	lines.push(context.description.trim() || "（用户未填写）");
	if (context.steps.trim()) {
		lines.push("");
		lines.push(`### 复现步骤`);
		lines.push(context.steps.trim());
	}
	lines.push("");
	lines.push(`## 体检结果`);
	lines.push(report.checks.length ? checkLines(report.checks).join("\n") : "（无检查项）");
	lines.push("");
	lines.push(`## 环境`);
	lines.push(environmentLines(report.environment).join("\n"));
	lines.push("");
	lines.push(`## 日志统计`);
	lines.push(logSummaryLine(report.logSummary));
	lines.push("");
	lines.push(`## 最近报错日志`);
	if (report.logSummary.recent.length === 0) {
		lines.push("（近 7 天无 error/warn）");
	} else {
		lines.push(...recentErrorLines(report.logSummary, 200));
	}
	if (projectContext) {
		lines.push("");
		lines.push(`## 项目上下文（${projectContext.projectName || projectContext.projectId}）`);
		// 项目地址给 GitHub 仓库而不是本地路径：分析者（外部 AI / 群友）通常没有本地源码，
		// 仓库地址才是唯一始终可访问的定位方式；本地开发场景 pi 的 cwd 本就是项目根，无需指路。
		lines.push(`项目地址（源码仓库）：https://github.com/ayuayue/PiDeck`);
		lines.push("");
		lines.push(`本次分析基于 PiDeck 工程。项目根目录的 AGENTS.md 记录了编码规范、架构约束与测试门禁，` + `以下为内容${projectContext.agentsMdTruncated ? "（超出上限已截断，可让 pi 读取项目根目录完整版）" : ""}：`);
		lines.push("");
		// 用 4 个反引号作围栏：AGENTS.md 正文可能自带 ```，3 反引号围栏会被提前闭合
		lines.push("````");
		lines.push(projectContext.agentsMd.trim() || "（项目无 AGENTS.md）");
		lines.push("````");
		if (projectContext.skills.length > 0) {
			lines.push("");
			lines.push(`项目级可用技能：${projectContext.skills.join(", ")}（如需可让 pi 执行 /skill:<名称> 获取使用说明）`);
		}
		lines.push(`提示：排查 PiDeck 自身问题时，可让 pi 使用全局技能 /skill:pideck-doctor 读取诊断报告与故障模式库。`);
	}
	lines.push("");
	lines.push("请输出：1) 最可能的根因（按可能性排序）；2) 每条的验证方法；3) 修复步骤；4) 修复后如何验证。");
	return lines.join("\n");
}

/** 按格式生成对应文本。projectContext 只参与 prompt 形态（新建会话分析用）。 */
export function formatReport(report: HealthReport, context: HealthReportContext, format: HealthReportFormat, projectContext?: FeedbackProjectContext): string {
	if (format === "card") return formatCard(report, context);
	if (format === "prompt") return formatAiPrompt(report, context, projectContext);
	return formatMarkdown(report, context);
}

/** 汇总体检概览：给标题区显示「3 异常 / 健康度 82」。 */
export function summarizeChecks(checks: HealthCheckItem[]): {
	ok: number;
	warn: number;
	error: number;
	skipped: number;
	score: number;
} {
	const tally = { ok: 0, warn: 0, error: 0, skipped: 0, score: 100 };
	for (const check of checks) tally[check.status] += 1;
	const evaluated = tally.ok + tally.warn + tally.error;
	if (evaluated > 0) {
		tally.score = Math.max(0, Math.round(((tally.ok + tally.warn * 0.5) / evaluated) * 100));
	}
	return tally;
}
