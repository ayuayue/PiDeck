/**
 * 提示词增强 / 输入预测两条一次补全通道共用的入参校验。
 *
 * 为什么要抽出来：两边的信任边界完全相同（渲染层来的 provider/modelId/正文一律不可信），
 * 复制一份校验就等于给未来留一份会漂移的安全实现。这里只做形态与预算判定，
 * 不碰业务，也不引用 Electron。
 */

import { ENHANCE_CONTEXT_MAX_CHARS, ENHANCE_CONTEXT_MAX_MESSAGES, type EnhanceContextMessage } from "../../shared/types/enhance";

/** 模型/供应商 id 是目录中的原始键：中文、空格、冒号、URL 均合法，
 * 不在 IPC 层复制 pi 的命名文法，也不 trim 后改掉实际查找键。 */
const MAX_MODEL_ID_LENGTH = 160;
const MODEL_ID_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

/** 草稿上限：输入框粘贴的长文本也会被增强，64KB 覆盖合理用途并挡住误传。 */
export const MAX_DRAFT_LENGTH = 64 * 1024;

export function nonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** 只拒绝空名称、控制字符与超长值；其余交给 pi 的模型目录匹配。 */
export function isModelId(value: unknown): value is string {
	return nonEmptyString(value, MAX_MODEL_ID_LENGTH) && !MODEL_ID_CONTROL_CHARACTERS.test(value);
}

/**
 * 上下文只接受正文白名单，并在发给独立助手前再次执行总预算检查。
 * `label` 只影响错误文案（两条通道的诊断要能区分），不影响判定。
 * 缺省/非数组空值返回空数组，由调用方决定「空上下文」是否合法。
 */
export function parseContextMessages(value: unknown, label: string): EnhanceContextMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > ENHANCE_CONTEXT_MAX_MESSAGES) throw new Error(`Invalid ${label} input: context`);
	const result: EnhanceContextMessage[] = [];
	let chars = 0;
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item) || !("role" in item) || (item.role !== "user" && item.role !== "assistant") || !("text" in item) || !nonEmptyString(item.text, ENHANCE_CONTEXT_MAX_CHARS)) throw new Error(`Invalid ${label} input: context`);
		chars += item.text.length;
		if (chars > ENHANCE_CONTEXT_MAX_CHARS) throw new Error(`Invalid ${label} input: context`);
		result.push({ role: item.role, text: item.text });
	}
	return result;
}
