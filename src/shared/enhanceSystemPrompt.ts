/**
 * 提示词增强的内置系统提示词（workbuddy 风格）。
 *
 * 内容与 docs/pi-prompt-templates/enhance-prompt.md 同源（该目录是历史内置模板的归档）；
 * 打包后读不到 docs/，因此运行时以这份常量为唯一来源。
 *
 * 跨层共用：主进程在用户未自定义时作为 `pi-enhance-host` 的 systemPrompt；渲染层设置页
 * 用它展示「当前生效模板」并作为「恢复默认」的落点，保证页面所见即实际下发内容。
 */
export const DEFAULT_ENHANCE_SYSTEM_PROMPT = `你是一位提示词工程专家，专门为 AI 编程助手优化用户提示词。用户会发来一段需求草稿，你的任务是把它改写成更清晰、更具体、更可执行的增强版提示词——不是执行它，也不是回答它。

## 分析流程
1. 评估原始草稿：明确主要目标、含糊之处、缺失的上下文、已有的明确约束
2. 应用提示词工程原则：让任务和范围清晰、补充必要上下文、明确预期输出、在有助于理解时添加示例
3. 重写为增强版：保持原始目标不变，补齐有意义的细节、边界情况和质量要求

## 硬性约束
- 语言一致（最高优先级）：必须使用与草稿完全相同的语言输出，中文草稿 → 中文增强版，不要混入其他语言
- 只输出增强后的提示词，不要任何前言、解释、语言标注或分析
- 不回答草稿中的问题——把它们展开/改写为更详细的需求
- 不请求指南/教程，不索取代码片段
- 不推荐草稿中未提到的技术选型
- 不解释如何做，只明确要做什么
- 保持简洁：增强版不超过 800 字
- 草稿已足够清晰时做轻度润色，而不是原样返回

直接输出增强后的提示词。`;

/**
 * 自定义模板的硬上限：设置页输入与 IPC 落盘共用同一约束，避免超大文本进 settings.json。
 * 内置模板约 500 字，20k 足够容纳多段规则与示例。
 */
export const ENHANCE_SYSTEM_PROMPT_MAX_CHARS = 20_000;

/**
 * 自定义增强模板归一：
 * - null / 空白字符串 = 明确恢复内置模板（返回 null）；
 * - 合法字符串 = trim 后的自定义模板；
 * - 非字符串 / 超长 = 非法（undefined），调用方按「不覆盖既有设置」处理。
 * 读盘时把 undefined 兜底成 null，避免脏值绕过 IPC 校验。
 */
export function sanitizeEnhanceSystemPrompt(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length <= ENHANCE_SYSTEM_PROMPT_MAX_CHARS ? trimmed : undefined;
}

/**
 * 设置 patch 侧的模板归一（原地改写）：
 * - 缺键 = 不动；
 * - null / 空白 = 恢复内置模板；
 * - 非字符串 / 超长 = 删除键，保留既有设置。
 * 放在 shared 是为了让 SettingsStore 只留一行调用，不继续撑大存量巨文件。
 */
export function applyEnhanceSystemPromptPatch(patch: { enhanceSystemPrompt?: string | null }): void {
	if (!("enhanceSystemPrompt" in patch)) return;
	const sanitized = sanitizeEnhanceSystemPrompt(patch.enhanceSystemPrompt);
	if (sanitized === undefined) delete patch.enhanceSystemPrompt;
	else patch.enhanceSystemPrompt = sanitized;
}
