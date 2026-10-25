import { compareVersions } from "../utils/versionCompare";

/**
 * 扩展白名单模式（--no-extensions + 逐条 -e 注入）的版本门槛。
 *
 * 门槛依据（来自 pi 官方仓库 README 历史 tag 考证）：
 * - v0.40.0 起 README 已有 `--extension <path>, -e` 与 `--no-extensions`（仅文件路径语义）；
 * - v0.60.0 起 `-e, --extension <source>` 文档化为 "Load extension from path, npm, or git"，
 *   目录 / npm 包源语义正式化——白名单注入的正是这类路径。
 * 因此低于 0.60 的老版本对 -e 目录/包源的行为未定义，可能报 unknown option 或 path not found，
 * 造成 RPC 启动失败；高于等于 0.60 的版本均可安全使用白名单。
 */
export const MIN_PI_VERSION_FOR_EXTENSION_WHITELIST = "0.60.0";

/**
 * 技能白名单模式（--no-skills + 逐条 --skill 注入）的版本门槛。
 *
 * 门槛依据（来自 pi 官方 CHANGELOG 考证）：
 * - 技能系统（含 --no-skills）自 0.52.0 起可用（0.52 修复 interactive 模式不加载问题）；
 * - `--skill <path>` CLI 参数自 0.50.0 起提供；
 * 保守沿用 0.60 与扩展白名单同一门槛，低于 0.60 的老版本不启用白名单、恢复默认发现，
 * 保证 RPC 启动行为与未启用时一致（禁用不生效但绝不启动失败）。
 */
export const MIN_PI_VERSION_FOR_SKILL_WHITELIST = "0.60.0";

/**
 * 提示词模板白名单模式（--no-prompt-templates + 逐条 --prompt-template 注入）的版本门槛。
 * `--prompt-template` 与 `--no-prompt-templates` 与 --skill/--no-skills 同批引入
 * （pi 0.50.0 的 CLI flags，CHANGELOG #645），保守沿用 0.60 与扩展/技能同一门槛。
 */
export const MIN_PI_VERSION_FOR_PROMPT_WHITELIST = "0.60.0";

/**
 * pi 0.99 起支持 `-e builtin:<name>` 形式的扩展源（内置扩展按名加载），
 * 同时 `--no-extensions` 的语义从「关掉文件型扩展发现」扩大为
 * 「关掉所有扩展，**含内置扩展**」（llama.cpp / codemode / tool-search / mcp）。
 *
 * 门槛依据（来自 pi 0.99.1 安装包源码考证）：
 * - `dist/extensions/index.js` 的 builtInExtensions 仅登记 4 个名字：
 *   `llama.cpp`、`codemode`、`tool-search`、`mcp`（后三个 replaceable）；
 * - `dist/core/package-manager.js` 的 resolveExtensionSources 用
 *   `source.startsWith("builtin:")` 过滤内置源，该分支在 0.99.0 引入
 *   （`-e, --extension <source>` 在此之前只接受 path / npm / git 源）；
 * - 低于 0.99 的 pi 传 `builtin:mcp` 会被当成未知源，resolvedPaths 为空或直接
 *   报错，导致 RPC 启动失败——因此必须版本门控。
 */
export const MIN_PI_VERSION_FOR_BUILTIN_EXTENSION_SPECIFIER = "0.99.0";

/**
 * 从 pi 版本串（如 "0.82.1" / "v1.0.0"）归一化为可比较的 semver 串；解析失败返回 null（视为版本未知）。
 *
 * 历史教训：这里曾只取第二段当 minor（0.x 时代的约定），pi 1.0.0 会被解析成 minor=0，
 * 导致 trust 标志拒绝启动、白名单门槛全部误判“过老”。任何新门槛都必须用完整版本比较。
 */
export function parsePiVersion(version: string | null | undefined): string | null {
	if (!version) return null;
	const trimmed = version.trim().replace(/^v/i, "");
	if (!/^\d+(\.\d+)*/.test(trimmed)) return null;
	return trimmed;
}

/**
 * pi 版本是否 >= 最低版本（完整 semver 比较，0.x 与 1.x+ 均正确）。
 * 版本未知/解析失败（null）时返回 false（保守不启用），与旧 minor 解析的行为一致。
 */
export function piVersionAtLeast(version: string | null | undefined, minVersion: string): boolean {
	const normalized = parsePiVersion(version);
	if (normalized === null) return false;
	return compareVersions(normalized, minVersion) >= 0;
}
