/**
 * MCP 配置表单辅助：KEY=value 文本与对象互转、参数拆分。
 * 放独立模块是为了可单测，并避免 McpTab 继续变长。
 */

import type { McpConfigFile, McpConfigLayerKind, McpConfigSnapshot, McpServerDefinition, McpServerListItem } from "../../../shared/types/mcp";

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** 与主进程 mcpConfig.isMcpServerName 同一规则，避免渲染层 import 主进程模块。 */
export function isMcpServerName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && !/[\\/]/.test(trimmed) && SERVER_NAME_RE.test(trimmed);
}

export function argsToText(args: string[] | undefined): string {
	return (args ?? []).join(" ");
}

export function textToArgs(text: string): string[] | undefined {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

/** 把 env/headers 编成每行 KEY=value；空对象返回空串。 */
export function recordToText(record: Record<string, string> | undefined): string {
	if (!record) return "";
	return Object.entries(record)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** 浅合并丢掉 undefined，避免覆盖层把下层 command/url 冲空。 */
export function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) (out as Record<string, unknown>)[key] = item;
	}
	return out;
}

/**
 * 主进程已按优先级合并六层；本函数只把本地可写草稿叠回显示列表，
 * 让未保存编辑立即生效（项目层不再参与：MCP 页固定全局作用域）。
 */
export function buildMcpDisplayServers(snapshot: McpConfigSnapshot, writable: McpConfigFile): McpServerListItem[] {
	const writableServers = writable.mcpServers ?? {};
	const writableScope: McpConfigLayerKind = snapshot.layers.find((layer) => layer.path === snapshot.writablePath)?.kind ?? "pi-agent";
	const seen = new Set<string>();
	const items = snapshot.servers.map((item) => {
		seen.add(item.name);
		const overlay = writableServers[item.name];
		if (!overlay) {
			// 草稿里没有但磁盘可写层有 = 用户在本层删了它，保存后才生效：标记待删除。
			// 下层（如全局）还有同名定义时改标「回退为继承」——保存后条目不会消失，只是换层。
			const pendingDelete = Boolean(snapshot.writableFile.mcpServers?.[item.name]);
			if (!pendingDelete) return item;
			return { ...item, pendingDelete: true, revertsToInherited: snapshot.lowerLayerNames.includes(item.name) };
		}
		// pi 语义：同名条目由可写层**整体替换**，不是字段级合并。
		return {
			...item,
			definition: overlay,
			originPath: snapshot.writablePath,
			originScope: writableScope,
			ownedByWritable: true,
		};
	});
	for (const [name, definition] of Object.entries(writableServers)) {
		if (seen.has(name)) continue;
		items.push({
			name,
			definition,
			originPath: snapshot.writablePath,
			originScope: writableScope,
			ownedByWritable: true,
		});
	}
	return items.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 解析 KEY=value 行。空行忽略；没有 `=` 的行当作值为空的 key。
 * 业务规则：等号后整段都是 value（允许再含 `=`）。
 */
export function textToRecord(text: string): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		const key = (eq === -1 ? line : line.slice(0, eq)).trim();
		if (!key) continue;
		out[key] = eq === -1 ? "" : line.slice(eq + 1);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// ── 智能添加（设计见 docs/mcp-config-ux-redesign.md A 片）────────────────
// 一个粘贴框认三种输入：URL / 命令行（整行拆 command+args）/ JSON 片段（整块配置、
// 命名映射或单条定义）。识别是纯函数：不访问网络、不校验服务器可达性（那由检测做）。

export type SmartAddParse = { kind: "url"; url: string } | { kind: "command"; command: string; args: string[] } | { kind: "json"; servers: Array<{ name: string; definition: McpServerDefinition }> };

const HOSTNAME_LIKE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?:\/[^\s]*)?$/;

/** 命令行分词：支持单双引号包裹含空格的参数（shlex 子集）。 */
function tokenizeCommandLine(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const char of input.trim()) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
		} else current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function isServerDefinitionLike(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.command === "string" || typeof record.url === "string" || typeof record.type === "string";
}

export function parseSmartAddInput(raw: string): SmartAddParse | null {
	const input = raw.trim();
	if (!input) return null;
	if (input.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(input);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			const record = parsed as Record<string, unknown>;
			// 三种 JSON 形态：整块 {mcpServers:{…}} / 命名映射 {名:{定义}} / 单条裸定义
			const source = record.mcpServers && typeof record.mcpServers === "object" && !Array.isArray(record.mcpServers) ? (record.mcpServers as Record<string, unknown>) : isServerDefinitionLike(record) ? { "": record } : isServerDefinitionLike(Object.values(record)[0]) ? record : null;
			if (!source) return null;
			const servers = Object.entries(source)
				.filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
				.map(([name, value]) => ({ name, definition: value as McpServerDefinition }));
			return servers.length > 0 ? { kind: "json", servers } : null;
		} catch {
			// 不是合法 JSON：继续按 URL/命令行识别
		}
	}
	if (/^https?:\/\//i.test(input)) {
		try {
			new URL(input);
		} catch {
			return null;
		}
		return { kind: "url", url: input };
	}
	// 无协议、无空格、形如域名的输入：按 https 补全（有协议的 URL 已在上面处理，不存在误拼接）
	// 无协议但形如主机名（可带路径）：按 https 补全。带未知协议（如 ftp://x）不匹配 → 落到命令行分支
	if (HOSTNAME_LIKE.test(input)) return { kind: "url", url: `https://${input}` };
	const tokens = tokenizeCommandLine(input);
	if (tokens.length === 0) return null;
	return { kind: "command", command: tokens[0], args: tokens.slice(1) };
}

/** 从 URL 推断 server 名：去常见前缀（mcp/api/www），取主机名主干。 */
export function suggestNameFromUrl(url: string): string {
	let hostname = "";
	try {
		hostname = new URL(url).hostname;
	} catch {
		return "";
	}
	const labels = hostname
		.toLowerCase()
		.split(".")
		.filter((label) => label && label !== "www");
	// 去掉常见服务前缀与末级（TLD/公有后缀），如 mcp.linear.app → linear、api.example.com → example
	const candidates = labels.slice(0, Math.max(1, labels.length - 1)).filter((label) => label !== "mcp" && label !== "api");
	const name = (candidates[candidates.length - 1] ?? labels[0] ?? "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	return name || "server";
}

/** 从命令行推断 server 名：npx/uvx 等运行器取首个包名参数（@scope/pkg → pkg），否则取命令基名。 */
export function suggestNameFromCommand(command: string, args: readonly string[]): string {
	const runner = command.split(/[\\/]/).pop() ?? command;
	if (/^(npx|pnpm|bunx|uvx|uv|pipx|deno)$/i.test(runner)) {
		const pkg = args.find((arg) => !arg.startsWith("-"));
		const base = (pkg ?? "").split("/").pop() ?? "";
		const cleaned = base
			.replace(/^(mcp[-_]?|@)/, "")
			.replace(/[^a-zA-Z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (cleaned) return cleaned;
	}
	return runner.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/** 单条 JSON 定义（无名）按其内容推断。 */
export function suggestNameFromDefinition(definition: McpServerDefinition): string {
	if (typeof definition.url === "string" && definition.url) return suggestNameFromUrl(definition.url);
	return suggestNameFromCommand(definition.command ?? "", definition.args ?? []);
}

/** 名称去重：base 已存在时追加 -2、-3…（server 名规则 ^[A-Za-z0-9_-]+$）。 */
export function uniqueServerName(base: string, existing: ReadonlySet<string>): string {
	const clean =
		base
			.replace(/[^a-zA-Z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "server";
	if (!existing.has(clean)) return clean;
	for (let index = 2; ; index += 1) {
		const candidate = `${clean}-${index}`;
		if (!existing.has(candidate)) return candidate;
	}
}

/**
 * 清理 pi mcp login/logout 的原始输出用于界面展示。
 * 原始 stdout 含超长授权 URL（response_type/client_id/code_challenge/state 等参数），
 * 直接上屏会把界面堆成一段乱码：去 URL、压空白、限长；完整信息仍在日志里。
 */
export function sanitizeLoginOutput(output: string, maxLength = 240): string {
	const cleaned = output
		.replace(/https?:\/\/\S+/g, "…")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * 启停开关的落盘定义：开启时彻底移除 enabled（连同 legacy disabled 键）——
 * 历史缺陷：开启分支只删 disabled 键，enabled:false 留在定义里原样写回，开关切了等于没切
 * （表现为「服务关闭后永远开不回来」）。停用时写 enabled:false，其余字段原样保留。
 */
export function applyEnabledToggle(existing: McpServerDefinition, disabled: boolean): McpServerDefinition {
	const { enabled: _enabled, disabled: _legacyDisabled, ...kept } = existing as McpServerDefinition & { disabled?: unknown };
	return disabled ? { ...kept, enabled: false } : kept;
}
