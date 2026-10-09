/**
 * ACP 工具登记表的校验与消毒(纯函数)。
 *
 * 设置(IPC 入参不可信)与渲染层表单共用同一份规则,单测见
 * tests/acpToolConfig.test.mjs。非法**条目**丢弃而不是拒绝整表:
 * 用户增删一条工具时,另一条脏数据不应阻断保存。
 */
import type { AcpToolConfig, AcpToolValidation } from "../../shared/types/acp";

/** 单字段长度上限(显示名/命令足够,防滥用)。 */
const NAME_MAX_CHARS = 80;
const COMMAND_MAX_CHARS = 300;
const ARGS_LIMIT = 32;
const TOOLS_LIMIT = 32;
const ENV_LIMIT = 16;
const ENV_VALUE_MAX_CHARS = 2000;

function cleanString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxChars) return undefined;
	// 控制字符一律拒绝(路径/参数里不该出现;也防终端转义注入展示文案)。
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

/** env 注入消毒:键必须是合法环境变量名,值限非控制字符文本(API key 等);失败条目丢弃。 */
function sanitizeEnv(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const env: Record<string, string> = {};
	let count = 0;
	for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
		if (count >= ENV_LIMIT) break;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) continue;
		if (typeof rawVal !== "string" || !rawVal || rawVal.length > ENV_VALUE_MAX_CHARS) continue;
		if (/[\u0000-\u001f\u007f]/.test(rawVal)) continue;
		env[rawKey] = rawVal;
		count += 1;
	}
	return count > 0 ? env : undefined;
}

/**
 * 新建/编辑单条工具的表单校验:返回 ok=false 时 reasonKey 供渲染层本地化。
 * duplicateAgainst 用于查重(编辑时排除自身 id)。
 */
export function validateAcpTool(input: { id?: string; name?: unknown; command?: unknown; args?: unknown; env?: unknown }, existing: AcpToolConfig[] = []): AcpToolValidation & { tool?: AcpToolConfig } {
	const name = cleanString(input.name, NAME_MAX_CHARS);
	const command = cleanString(input.command, COMMAND_MAX_CHARS);
	const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0).slice(0, ARGS_LIMIT) : [];
	const env = sanitizeEnv(input.env);
	if (!name) return { ok: false, reasonKey: "acp.toolNameRequired" };
	if (!command) return { ok: false, reasonKey: "acp.toolCommandRequired" };
	// 显示名重复会让会话列表/选择器难区分;命令本身允许重复(同一 CLI 不同参数)。
	if (existing.some((tool) => tool.name === name && tool.id !== input.id)) return { ok: false, reasonKey: "acp.toolDuplicateName" };
	return {
		ok: true,
		tool: {
			id: typeof input.id === "string" && input.id.trim() ? input.id : createAcpToolId(),
			name,
			command,
			args,
			...(env ? { env } : {}),
			enabled: true,
		},
	};
}

/** 渲染层不应用 crypto/randomUUID 造 id(纯函数可测):时间戳+随机后缀。 */
export function createAcpToolId(): string {
	return `acp-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 设置加载/更新边界的整表消毒:非法条目丢弃,合法条目字段归一。 */
export function sanitizeAcpTools(value: unknown): AcpToolConfig[] {
	if (!Array.isArray(value)) return [];
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	const tools: AcpToolConfig[] = [];
	for (const raw of value.slice(0, TOOLS_LIMIT)) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const id = typeof record.id === "string" && record.id.trim() ? record.id : createAcpToolId();
		if (seenIds.has(id)) continue;
		const name = cleanString(record.name, NAME_MAX_CHARS);
		const command = cleanString(record.command, COMMAND_MAX_CHARS);
		if (!name || !command || seenNames.has(name)) continue;
		const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0).slice(0, ARGS_LIMIT) : [];
		const env = sanitizeEnv(record.env);
		seenIds.add(id);
		seenNames.add(name);
		tools.push({ id, name, command, args, ...(env ? { env } : {}), enabled: record.enabled !== false });
	}
	return tools;
}
