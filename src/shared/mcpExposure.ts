/**
 * MCP exposure 兼容别名归一（纯函数，主进程与渲染层共用）。
 *
 * pi 0.99.2 起 `codemode-deferred` 是 `codemode` 的兼容别名：校验、展示、有效态都必须按
 * 归一后的值判断，否则渲染层会把它当成枚举外的「自定义值」（ConfigSelect 兜底显示原字符串）。
 * 但**不回写文件**：原生配置里保留用户/pi 写下的原文，只有用户显式编辑该字段时才落盘规范值。
 */

import type { McpServerDefinition } from "./types/mcp";

/** 单个 exposure 值归一：`codemode-deferred` → `codemode`，其余（含 undefined）原样返回。 */
export function resolveExposureAlias(value: unknown): unknown {
	return value === "codemode-deferred" ? "codemode" : value;
}

/** 一个 server 的 exposure 与 toolExposure 全部归一（展示/编辑预选值用，不改原文）。 */
export function resolveExposureAliases(def: McpServerDefinition): McpServerDefinition {
	const resolved: McpServerDefinition = { ...def };
	if (def.exposure !== undefined) resolved.exposure = resolveExposureAlias(def.exposure) as McpServerDefinition["exposure"];
	if (def.toolExposure && isRecord(def.toolExposure)) {
		resolved.toolExposure = Object.fromEntries(Object.entries(def.toolExposure).map(([tool, exposure]) => [tool, resolveExposureAlias(exposure)])) as McpServerDefinition["toolExposure"];
	}
	return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
