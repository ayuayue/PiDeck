import type { HealthReport } from "../../../../shared/types";

/**
 * GitHub Issue 预填 URL 构造（issue #397）。
 *
 * 为什么独立成纯模块：GitHub 对超长查询串直接回「Whoa there! Your request URL is too long.」。
 * 旧实现把整份 Markdown 报告（含最多 150 条报错日志）塞进 body，中文经 encodeURIComponent
 * 后一个字变 9 个字符，URL 轻松几万字符 → 用户在「导出分享」页点「打开 GitHub Issue」只看到
 * GitHub 的错误页，issue 根本发不出去。
 *
 * 现在的契约：
 * - URL 只带标题 + 用户描述 + 复现步骤 + 环境摘要，整条 URL 硬预算 {@link GITHUB_ISSUE_URL_BUDGET}；
 *   超预算按「编码后长度」二分截断描述/步骤，并用 truncated 标记。
 * - 完整报告不进 URL：调用方把它放剪贴板，正文末尾留一条 HTML 注释告诉用户粘在哪里
 *   （注释提交后渲染不可见，不污染 Issue 正文）。
 *
 * 为什么按编码后长度算预算：CJK 每个字 encodeURIComponent 后是 9 个字符、换行是 3 个，
 * 按「字符数」估算会严重低估（1000 字中文描述 ≈ 9000 字符）。
 */

/** 整条预填 URL 的字符预算；GitHub 的拒绝阈值更高，留出浏览器/中转代理的余量。 */
export const GITHUB_ISSUE_URL_BUDGET = 6000;
/** 标题字符上限（进 URL 前同样要编码，长描述首行会直接撞预算）。 */
const MAX_TITLE_CHARS = 90;
const ELLIPSIS = "…";
const EMPTY_DESCRIPTION = "（未填写 / none）";
const STEPS_HEADING = "\n\n### Repro steps\n";
/** 仓库根地址；测试可经入参覆盖。 */
export const DEFAULT_FEEDBACK_REPO = "https://github.com/ayuayue/PiDeck";

/**
 * 完整报告在剪贴板里这件事必须告诉提交者，否则他只会看到一个没有报告的 Issue。
 * 用 HTML 注释而不是可见文案：提交后渲染不可见，Issue 正文保持干净。
 */
const CLIPBOARD_MARKER = "<!-- PiDeck 已把完整诊断报告（体检项 + 最近报错日志）复制到剪贴板，粘贴到本行下方即可。/ The full diagnostic report is on your clipboard — paste it below this line. -->";

export type FeedbackIssueInput = {
	/** Issue 标题（调用方已拼好 i18n 前缀）。 */
	title: string;
	description: string;
	steps: string;
	/** 体检报告；没跑体检时为 null，此时正文只有用户输入。 */
	report?: HealthReport | null;
	repoUrl?: string;
};

export type FeedbackIssueResult = {
	/** 可直接交给 openExternal 的预填 URL，长度保证不超过 {@link GITHUB_ISSUE_URL_BUDGET}。 */
	url: string;
	/** 解码后的正文，便于测试与预览。 */
	body: string;
	/** 描述/步骤是否被截断（完整内容在剪贴板报告里）。 */
	truncated: boolean;
};

function encodedLength(text: string): number {
	return encodeURIComponent(text).length;
}

/**
 * 去掉孤立代理项：按字符二分截断可能把 emoji（代理对）劈成两半，
 * encodeURIComponent 遇到孤立代理项会直接抛 URIError——反馈弹窗里的用户文本不可信。
 */
function stripLoneSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** 取最长前缀，使 encodeURIComponent 后不超过 budget；截断时补省略号（省略号本身也占预算）。 */
function sliceByEncodedBudget(text: string, budget: number): { text: string; truncated: boolean } {
	if (!text) return { text: "", truncated: false };
	if (encodedLength(text) <= budget) return { text, truncated: false };
	const reserved = encodedLength(ELLIPSIS);
	if (budget <= reserved) return { text: "", truncated: true };
	// encodeURIComponent 长度随前缀长度单调不减，二分取边界值
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (encodedLength(stripLoneSurrogates(text.slice(0, mid))) <= budget - reserved) low = mid;
		else high = mid - 1;
	}
	return { text: `${stripLoneSurrogates(text.slice(0, low))}${ELLIPSIS}`, truncated: true };
}

/** 标题：单行化 + 上限截断；换行会把 `&title=` 之后的查询语义写坏。 */
function normalizeTitle(raw: string): string {
	const flat = stripLoneSurrogates(raw).replace(/\s+/g, " ").trim();
	return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS)}${ELLIPSIS}` : flat;
}

/** 环境摘要：只留定位 issue 必需的几行；日志/内存/路径不进 URL（那是剪贴板的活）。 */
function environmentSummary(report?: HealthReport | null): string[] {
	const env = report?.environment;
	if (!env) return [];
	const osLabel = env.platform === "win32" ? `Windows ${env.osVersion}` : env.platform === "darwin" ? `macOS ${env.osVersion}` : `${env.platform} ${env.osVersion}`;
	return [`- PiDeck ${env.appVersion} (${env.installMode})`, `- OS: ${osLabel} (${env.arch})`, `- Electron ${env.electronVersion} / Chrome ${env.chromeVersion} / Node ${env.nodeVersion}`, `- Locale: ${env.locale} · TZ: ${env.timezone}`];
}

function composeBody(description: string, steps: string, environment: string[]): string {
	const lines: string[] = ["## Problem", description || EMPTY_DESCRIPTION];
	if (steps) lines.push("", "### Repro steps", steps);
	if (environment.length > 0) lines.push("", "## Environment", ...environment);
	lines.push("", CLIPBOARD_MARKER);
	return lines.join("\n");
}

/**
 * 构造 GitHub Issue 预填链接：标题与用户简述进 URL，完整报告由调用方另行放剪贴板。
 * 预算守恒：available = 总预算 − 前缀 − 固定骨架（含空描述占位/步骤小标题），再按 7:3 分给描述与步骤；
 * 最后还有一道兜底——仍超预算就退回只带骨架正文，保证 URL 永远在预算内。
 */
export function buildFeedbackIssueUrl(input: FeedbackIssueInput): FeedbackIssueResult {
	const repo = (input.repoUrl ?? DEFAULT_FEEDBACK_REPO).replace(/\/+$/, "");
	const title = normalizeTitle(input.title);
	const description = stripLoneSurrogates(input.description.trim());
	const steps = stripLoneSurrogates(input.steps.trim());
	const environment = environmentSummary(input.report);

	const prefix = `${repo}/issues/new?title=${encodeURIComponent(title)}&body=`;
	// 骨架里已含空描述占位与（可能的）步骤标题，先当作已花掉的预算
	let available = GITHUB_ISSUE_URL_BUDGET - encodedLength(prefix) - encodedLength(composeBody(EMPTY_DESCRIPTION, "", environment));
	if (description) available += encodedLength(EMPTY_DESCRIPTION); // 占位被真实描述替换，这笔预算回收
	if (steps) available -= encodedLength(STEPS_HEADING);

	let descriptionBudget = 0;
	let stepsBudget = 0;
	if (description && steps) {
		descriptionBudget = Math.floor(Math.max(0, available) * 0.7);
		stepsBudget = Math.max(0, available) - descriptionBudget;
	} else if (description) {
		descriptionBudget = Math.max(0, available);
	} else if (steps) {
		stepsBudget = Math.max(0, available);
	}

	const descriptionSlice = sliceByEncodedBudget(description, descriptionBudget);
	const stepsSlice = sliceByEncodedBudget(steps, stepsBudget);
	let body = composeBody(descriptionSlice.text, stepsSlice.text, environment);
	let url = `${prefix}${encodeURIComponent(body)}`;
	let truncated = descriptionSlice.truncated || stepsSlice.truncated;

	// 兜底：预算核算若有偏差（环境行异常长等），宁可丢掉用户输入也不让 URL 超限
	if (url.length > GITHUB_ISSUE_URL_BUDGET) {
		body = composeBody("", "", environment);
		url = `${prefix}${encodeURIComponent(body)}`;
		truncated = true;
	}

	return { url, body, truncated };
}
