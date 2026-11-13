import { closeSync, openSync, readSync } from "node:fs";
import { open as openFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionLocator, SessionSummary } from "../../../shared/types";
import { getCodexSessionThreadInfo } from "../../../shared/codexSessionMeta";
import { replaceExpandedRefBlocksWithLabels } from "../../../shared/expandedRefBlocks";
import { isRoleMessageRole } from "../../pi/sessionEntryIds";
import type { SessionFileVersion, SessionSummaryCache } from "../sessionSummaryCache";
import { extractTextFromContent, inferSessionTitleFromLines, isSessionScanLine, type SessionScanMessage } from "../sessionNameLine";
import { inferProjectPathFromFile, normalizeSessionPath } from "./sessionPathDerivation";

/** 摘要只读文件前缀：catalog 不需要整份历史，1MB 足够取 cwd/预览/模型。 */
const SUMMARY_PARSE_MAX_BYTES = 1024 * 1024;

/** readSummary 需要的宿主持有面：文件指纹/窗口读取、摘要缓存、路径与文案。 */
export type SessionSummaryReadHost = {
	isWslPath(filePath: string): boolean;
	readWslFileVersion(filePath: string, signal?: AbortSignal): Promise<SessionFileVersion>;
	readWslFileHead(filePath: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
	/** 摘要缓存的持有者仍是宿主：list() 的剪枝与刷盘都走同一个实例。 */
	readonly summaryCache: SessionSummaryCache<SessionSummary | null>;
	/** 旧缓存条目缺 locator 时补齐（宿主统一 locator 生成口径）。 */
	withSessionLocator(summary: SessionSummary): SessionSummary;
	sessionLocatorForPath(filePath: string, isWsl: boolean): SessionLocator;
	inferParentSessionFromPath(filePath: string): string | undefined;
	inferWslParentSessionFromPath(filePath: string, signal?: AbortSignal): Promise<string | undefined>;
	resolveForkParentPath(filePath: string, forkParentSession: string, isWsl: boolean, sessionCwd?: string, signal?: AbortSignal): Promise<string | undefined>;
	canonicalProjectPath(path: string, wsl: boolean): string;
	/** 路径比「sessions 根下的单层 jsonl」更深（父会话探测的门禁）。 */
	looksLikeNestedSessionPath(filePath: string): boolean;
	/** 无名称/无预览时的占位文案（宿主持有 i18n 注入）。 */
	translate(key: "session.emptyPreview" | "session.untitled"): string;
	/** Codex 导入文件的来源目录（readCodexThreadInfo 只认该根下的会话）。 */
	readonly codexRoot: string;
};

export function optionalString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractText(content: unknown): string {
	// 实现搬到 sessionNameLine.extractTextFromContent：与远端按需标题共用同一份提取口径。
	return extractTextFromContent(content);
}

function readCodexThreadInfo(host: SessionSummaryReadHost, sourcePath: string) {
	try {
		const root = normalizeSessionPath(host.codexRoot);
		const target = normalizeSessionPath(sourcePath);
		if (target !== root && !target.startsWith(`${root}/`)) return undefined;
		for (const line of readLocalFileHead(sourcePath).split(/\r?\n/).filter(Boolean).slice(0, 16)) {
			const entry = JSON.parse(line);
			if (entry?.type === "session_meta" && entry.payload) {
				return getCodexSessionThreadInfo(entry.payload);
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function readLocalFileHead(filePath: string, maxBytes = 4096): string {
	const fd = openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		closeSync(fd);
	}
}

export async function readLocalFilePrefix(filePath: string, maxBytes: number): Promise<string> {
	const handle = await openFile(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** 读取本地文件尾部窗口；起点按字节计算，避免大会话全量加载进主进程。 */
export async function readLocalFileSuffix(filePath: string, maxBytes: number, fileSize: number): Promise<string> {
	const handle = await openFile(filePath, "r");
	try {
		const bytesToRead = Math.min(maxBytes, fileSize);
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, Math.max(0, fileSize - bytesToRead));
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

export async function readSessionSummary(host: SessionSummaryReadHost, filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
	// 先读取轻量文件指纹；未变化时复用摘要，避免周期扫描反复读取和解析全部 JSONL。
	const isWsl = host.isWslPath(filePath);
	const info = isWsl ? await host.readWslFileVersion(filePath, signal) : await stat(filePath);
	// schema v2：摘要新增 hasImageGen；不带 tag 的旧缓存缺字段，会一直不显示角标
	const version = { mtimeMs: info.mtimeMs, size: info.size, schema: 2 };
	const cached = host.summaryCache.get(filePath, version);
	if (cached !== undefined) return cached ? host.withSessionLocator(cached) : cached;

	// catalog 摘要只读前缀：整文件 parse 会在后台扫描时占满主线程，点击/输入跟着卡。
	const raw = isWsl ? await host.readWslFileHead(filePath, SUMMARY_PARSE_MAX_BYTES, signal) : await readLocalFilePrefix(filePath, SUMMARY_PARSE_MAX_BYTES);
	const truncated = version.size > SUMMARY_PARSE_MAX_BYTES;
	const text = truncated ? raw.slice(0, Math.max(0, raw.lastIndexOf("\n"))) : raw;
	const lines = text.split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) {
		host.summaryCache.set(filePath, version, null);
		return null;
	}

	let projectPath: string | undefined;
	const emptyPreview = host.translate("session.emptyPreview");
	let preview = emptyPreview;
	let messageCount = 0;
	/** 会话来源：扫描前几行检测导入标记 */
	let source: SessionSummary["source"] = "pi";
	let codexSessionId: string | undefined;
	let codexThreadSource: SessionSummary["codexThreadSource"];
	let codexParentThreadId: string | undefined;
	let codexAgentRole: string | undefined;
	let codexAgentNickname: string | undefined;
	let codexSourcePath: string | undefined;
	let latestSessionInfoName: string | undefined;
	let forkParentSession: string | undefined;
	// 会话 header 的 cwd：resolveForkParentPath 的第二解析基准（扩展写入相对 cwd 的 parentSession）。
	let sessionHeaderCwd: string | undefined;
	let hasSubagentChildMarker = false;
	/** 最后一条 model_change / thinking_level_change 记录 */
	let modelProvider: string | undefined;
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;
	/** 扫描范围内是否出现生图消息（侧栏图片角标用） */
	let hasImageGen = false;
	/** 最后一条 assistant 消息携带的 provider/model（旧格式兼容回退）。 */
	let lastAssistantModel: { provider: string; modelId: string } | undefined;

	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 损坏行或前缀截断的半行：跳过，不影响该会话摘要。
			continue;
		}
		if (!isSessionScanLine(parsed)) continue;
		const entry = parsed;
		if (entry.type === "session_info") {
			// Forked sessions may contain an older copied name; only the latest marker is authoritative.
			latestSessionInfoName = optionalString(entry.name ?? entry.data?.name);
		}
		if (entry.type === "session") {
			forkParentSession ||= optionalString(entry.parentSession ?? entry.header?.parentSession);
			sessionHeaderCwd ||= optionalString(entry.cwd ?? entry.header?.cwd);
		}
		// 检测显式子会话标记：支持任何 "*.child-session" 格式，
		// 不仅限于 pi-subagents，未来其他扩展也可沿用此约定。
		if (entry.type === "custom" && typeof entry.customType === "string" && entry.customType.endsWith(".child-session")) {
			hasSubagentChildMarker = true;
		}
		// 扫描前几行的非消息条目，检测导入来源标记
		if (source === "pi") {
			if (entry.type === "codex_import") {
				source = "codex";
				codexSessionId = optionalString(entry.codexSessionId);
				codexSourcePath = optionalString(entry.sourcePath);
				codexThreadSource = entry.threadSource === "subagent" ? "subagent" : "user";
				codexParentThreadId = optionalString(entry.parentThreadId);
				codexAgentRole = optionalString(entry.agentRole);
				codexAgentNickname = optionalString(entry.agentNickname);
			} else if (entry.type === "claude_import") source = "claude";
			else if (entry.type === "qoder_import") source = "qoder";
			else if (entry.type === "opencode_import") source = "opencode";
			else if (entry.type === "zcode_import") source = "zcode";
			else if (entry.type === "workbuddy_import") source = "workbuddy";
			else if (entry.type === "codebuddy_import") source = "codebuddy";
			else if (entry.type === "cursor_import") source = "cursor";
			else if (entry.type === "kimi_import") source = "kimi";
			else if (entry.type === "minimax_import") source = "minimax";
		}

		projectPath ||= entry.cwd || entry.projectPath || entry.header?.cwd || entry.data?.cwd || entry.session?.cwd || entry.data?.session?.cwd;

		// Track the last model_change / thinking_level_change so the catalog can
		// surface them to the renderer even when the Agent is not running.
		if (entry.type === "model_change") {
			modelProvider = typeof entry.provider === "string" ? entry.provider : modelProvider;
			modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
		} else if (entry.type === "thinking_level_change") {
			thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : thinkingLevel;
		}

		const nested = entry.message ?? entry.data?.message;
		const message: SessionScanMessage = nested ?? {
			role: entry.role,
			content: entry.content,
			provider: entry.provider,
			model: entry.model,
		};
		// 只数会进时间线的角色消息：pi 0.86 起系统提示/工具清单变更也是 type:"message"
		// （role:"system"），算进消息数会让侧栏/列表计数虚高（首个请求 +1、每次补丁再 +1）。
		if (isRoleMessageRole(message.role)) {
			messageCount += 1;
			const text = extractText(message.content).trim();
			// 侧栏会话 preview 是纯文本出口：折叠自包含引用块，避免露出 <quoted_context> 等 XML 原文。
			if (text && preview === emptyPreview) preview = replaceExpandedRefBlocksWithLabels(text);
			// 旧 JSONL 可能没有 model_change；从最后一条 assistant 消息回退模型。
			if (message.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
				lastAssistantModel = { provider: message.provider, modelId: message.model };
			}
		}
	}

	// 旧会话不包含 model_change / thinking_level_change 时，
	// 按 pi getSessionContextSettings 的回退规则补齐：
	//   - 模型取自最后一条 assistant 消息的 provider / model 字段
	//   - 模型从消息恢复成功时，认为 Agent 曾经运行过，未记录的思考强度视为 "off"
	if (!modelProvider || !modelId) {
		if (lastAssistantModel) {
			modelProvider = lastAssistantModel.provider;
			modelId = lastAssistantModel.modelId;
		}
	}
	if (thinkingLevel == null && (modelProvider || lastAssistantModel)) {
		thinkingLevel = "off";
	}

	// 检测子会话：任意扩展产生的内部 worker/reviewer 会话。
	// 不在顶层列表显示，而是设置 parentSessionPath 供 UI 嵌套渲染。
	//
	// 采用分层信号打分机制，兼容不同扩展的子会话存储方式：
	//   强信号（2分）：路径布局匹配、显式 customType 标记
	//   弱信号（1分）：子会话命名模式、parentSession header 引用
	//   置信度阈值：≥ 2 分判定为子会话
	const subagentScore = {
		pathInferred: 0, // 路径布局 ← 新泛化算法
		customMarker: 0, // customType: "*.child-session"
		namePattern: 0, // sessionName 以 "subagent-" 开头
		parentHeader: 0, // session header 中的 parentSession
		tintinwebMarker: 0, // tintinweb 平铺子代理：会话名 <agent>#<8hex> + parentSession header
	};

	const pathInferredParent = isWsl ? await host.inferWslParentSessionFromPath(filePath, signal) : host.inferParentSessionFromPath(filePath);
	subagentScore.pathInferred = pathInferredParent ? 2 : 0;
	subagentScore.customMarker = hasSubagentChildMarker ? 2 : 0;
	subagentScore.namePattern = latestSessionInfoName?.startsWith("subagent-") ? 1 : 0;
	subagentScore.parentHeader = forkParentSession ? 1 : 0;
	// @tintinweb/pi-subagents 持久化的子代理会话是 pi 原生平铺文件（与父同目录，
	// 文件名 <timestamp>_<sessionId>.jsonl），路径推断与 subagent- 前缀都不命中；
	// 它 setSessionName("<agent>#<id 前 8 位>")（UUID 片段，8 位 16 进制），
	// 且 header 带 parentSession——该形态与 pi 原生 fork 同构，仅靠名字模式区分。
	subagentScore.tintinwebMarker = Boolean(forkParentSession) && /^[^#]+#[0-9a-f]{8}$/i.test(latestSessionInfoName ?? "") ? 2 : 0;

	const confidenceScore = subagentScore.pathInferred + subagentScore.customMarker + subagentScore.namePattern + subagentScore.parentHeader + subagentScore.tintinwebMarker;

	let parentSessionPath: string | undefined;
	if (source === "pi" && confidenceScore >= 2) {
		// 优先复用上面已完成的路径推断，避免重复遍历文件系统/WSL。
		parentSessionPath = pathInferredParent;
		// 路径推断失败时，尝试使用 forkParentSession header 引用的父路径
		if (!parentSessionPath && forkParentSession) {
			parentSessionPath = await host.resolveForkParentPath(filePath, forkParentSession, isWsl, sessionHeaderCwd, signal);
		}
	}

	if (source === "codex" && codexSourcePath && !codexParentThreadId) {
		const fallbackInfo = readCodexThreadInfo(host, codexSourcePath);
		if (fallbackInfo) {
			codexThreadSource = fallbackInfo.threadSource;
			codexParentThreadId = fallbackInfo.parentThreadId;
			codexAgentRole = fallbackInfo.agentRole;
			codexAgentNickname = fallbackInfo.agentNickname;
		}
	}

	// 会话名优先级与 pi getSessionName 一致：最后一条 session_info 为准；
	// 旧版 PiDeck 的 sessionName 私有行及其他字段仅作降级回退。
	// pi 默认 sessionName / 未改名的 session_info 是 JSONL 文件名时间戳，不能当标题。
	// 与轻量补名共用 inferSessionTitleFromLines，保证两处推断结果一致。
	const inferred = inferSessionTitleFromLines(lines, (content) => extractText(content));
	const inferredName = inferred.name || host.translate("session.untitled");

	const summary: SessionSummary = {
		id: filePath,
		filePath,
		locator: host.sessionLocatorForPath(filePath, isWsl),
		projectPath: projectPath ? host.canonicalProjectPath(projectPath, isWsl) : inferProjectPathFromFile(filePath),
		name: inferredName,
		// 无名称时的会话占位文案不是权威名；有名称时透传来源供 catalog 定所有权（#266）。
		nameFromSessionInfo: inferred.name ? inferred.fromSessionInfo : undefined,
		preview: preview.slice(0, 160),
		updatedAt: info.mtimeMs,
		messageCount,
		source,
		codexSessionId,
		codexThreadSource,
		codexParentThreadId,
		codexAgentRole,
		codexAgentNickname,
		parentSessionPath,
		model: modelProvider && modelId ? { provider: modelProvider, modelId } : undefined,
		thinkingLevel,
		hasImageGen: hasImageGen || undefined,
		// 标记 WSL 来源，供 rename/delete/copy/readMessages 等操作识别
		wsl: isWsl || undefined,
	};
	host.summaryCache.set(filePath, version, summary);
	return summary;
}

/** 会话文件头是否包含可解析记录（供父会话推断快速判真，不读整份 JSONL）。 */
export function isSessionFile(filePath: string): boolean {
	try {
		return hasSessionHeader(readLocalFileHead(filePath));
	} catch {
		return false;
	}
}

export function hasSessionHeader(raw: string): boolean {
	for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 12)) {
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return true;
		} catch {
			// 跳过无法解析的行（损坏/二进制残留），继续检查后续行中的 type 字段
			continue;
		}
	}
	return false;
}

/**
 * 侧栏 list() 专用：只 stat + 路径推断，不读 JSONL 正文。
 * 标题/预览留给 catalog；模型/思考在历史读取完成后回填；点开会话走轮次历史页。
 * 不写入 summaryCache——空标题一旦进缓存，会把后续真正的 readSummary 结果冻住。
 */
export async function listPathSummary(host: SessionSummaryReadHost, filePath: string, signal?: AbortSignal): Promise<SessionSummary | null> {
	const isWsl = host.isWslPath(filePath);
	const info = isWsl ? await host.readWslFileVersion(filePath, signal) : await stat(filePath);
	const source = inferSourceFromFileName(filePath);
	// 只对明显嵌套的路径查父会话，避免每个顶层 JSONL 都走 exists/wsl.exe。
	const nested = host.looksLikeNestedSessionPath(filePath);
	const parentSessionPath = source === "pi" && nested ? (isWsl ? await host.inferWslParentSessionFromPath(filePath, signal) : host.inferParentSessionFromPath(filePath)) : undefined;
	return {
		id: filePath,
		filePath,
		locator: host.sessionLocatorForPath(filePath, isWsl),
		projectPath: inferProjectPathFromFile(filePath),
		preview: "",
		updatedAt: info.mtimeMs,
		messageCount: 0,
		source,
		parentSessionPath,
		wsl: isWsl || undefined,
		// originKey 对 Codex 导入含 importedSourceId；从文件名 codex_<id>.jsonl 还原，避免扫描后变成另一条记录。
		codexSessionId: source === "codex" ? inferImportedIdFromFileName(filePath, "codex_") : undefined,
	};
}

/** 导入器约定文件名：codex_<id>.jsonl / claude_<id>.jsonl / qoder_<id>.jsonl / opencode_<id>.jsonl / zcode_<id>.jsonl / workbuddy_<id>.jsonl / codebuddy_<id>.jsonl / cursor_<id>.jsonl / kimi_<id>.jsonl / kimiwork_<id>.jsonl / minimax_<id>.jsonl。 */
function inferSourceFromFileName(filePath: string): NonNullable<SessionSummary["source"]> {
	const base = basename(filePath).toLowerCase();
	if (base.startsWith("codex_")) return "codex";
	if (base.startsWith("claude_")) return "claude";
	if (base.startsWith("qoder_")) return "qoder";
	if (base.startsWith("opencode_")) return "opencode";
	if (base.startsWith("zcode_")) return "zcode";
	if (base.startsWith("workbuddy_")) return "workbuddy";
	if (base.startsWith("codebuddy_")) return "codebuddy";
	if (base.startsWith("cursor_")) return "cursor";
	if (base.startsWith("kimi_")) return "kimi";
	if (base.startsWith("kimiwork_")) return "kimiwork";
	if (base.startsWith("minimax_")) return "minimax";
	return "pi";
}

function inferImportedIdFromFileName(filePath: string, prefix: string): string | undefined {
	const base = basename(filePath);
	if (!base.toLowerCase().startsWith(prefix) || !base.toLowerCase().endsWith(".jsonl")) return undefined;
	const id = base.slice(prefix.length, -".jsonl".length).trim();
	return id || undefined;
}
