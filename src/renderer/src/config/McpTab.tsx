/**
 * Pi 配置管理 → MCP 页（全局作用域）与项目资源管理器 → MCP 页（项目作用域）共用。
 * 作用域由 props.scope 决定：全局页写 ~/.pi/agent/mcp.json，项目页写所选项目 .pi/mcp.json
 * （均经主进程信任门禁与项目边界校验）。不启动 MCP 运行时；轻量探测仅检查 command 是否在
 * PATH / HTTP 是否可达，真实连接检测走 `pi mcp list --json`。
 * pi 0.99.2 语义：同名条目整体替换；`enabled` 是唯一启停字段；auth.provider 是供应商登录模式。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2, PlugZap, RefreshCw, TriangleAlert, ChevronRight, Copy, LogIn, LogOut } from "lucide-react";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import { Label } from "../components/ui-shadcn/label";
import { Textarea } from "../components/ui-shadcn/textarea";
import { ConfigSelect, openDocsInSystemBrowser } from "./ConfigShared";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui-shadcn/collapsible";
import { detectThirdPartyMcpExtensions, hasLegacyDisabledField, inferMcpTransport, isMcpServerDisabled, McpServerListPane, usesMcpOAuth, usesProviderAuth, type ThirdPartyMcpExtension } from "./McpResourceViews";
import { argsToText, applyEnabledToggle, buildMcpDisplayServers, isMcpServerName, recordToText, sanitizeLoginOutput, textToArgs, textToRecord } from "./mcpForm";
import { resolveExposureAliases } from "../../../shared/mcpExposure";
import { isProjectUntrustedError } from "./projectResourceErrors";
import type { McpCliListResult, McpConfigFile, McpConfigScope, McpConfigSnapshot, McpExposure, McpOAuth, McpProbeResult, McpServerDefinition, McpServerListItem, McpServerTransport } from "../../../shared/types/mcp";
import { ResourceImportDialog } from "./ResourceImportDialog";
import { McpSmartAdd, type SmartAddEntry } from "./McpSmartAdd";
import { McpServiceTemplateForm } from "./McpServiceTemplateForm";
import { MCP_SERVICE_CATALOG } from "./mcpServiceCatalog";

const api = (
	window as unknown as {
		piDesktop: {
			config: {
				getMcp: (scope?: McpConfigScope) => Promise<McpConfigSnapshot>;
				getAuth: () => Promise<{ raw: string; parsed: Record<string, unknown>; diagnostic?: unknown }>;
				installMcpSetupSkill: () => Promise<{ success: boolean; path?: string; error?: string }>;
				saveMcp: (data: McpConfigFile, scope?: McpConfigScope, expectedRevision?: string) => Promise<{ valid: boolean; error?: string; conflict?: boolean }>;
				probeMcp: (definition: McpServerDefinition) => Promise<McpProbeResult>;
				/** pi mcp CLI：真实连接检测 + OAuth 登录/登出（仅命令路线，见计划 M2）。 */
				mcpListStatus: (scope?: McpConfigScope) => Promise<McpCliListResult>;
				mcpLogin: (server: string, timeoutSec?: number, scope?: McpConfigScope, operationId?: string) => Promise<{ ok: boolean; output: string }>;
				mcpLogout: (server: string, scope?: McpConfigScope) => Promise<{ ok: boolean; output: string }>;
				onMcpLoginUrl: (callback: (payload: { server: string; scope?: McpConfigScope; operationId?: string; url: string }) => void) => () => void;
			};
			app: {
				openExternal: (url: string, forceSystem?: boolean) => Promise<void> | void;
			};
		};
	}
).piDesktop;

const MCP_DOCS = "https://earendil-works.github.io/pi/docs/mcp";
const EMPTY_FILE: McpConfigFile = { mcpServers: {} };

/**
 * exposure 选项：0.99.2 起 `codemode-deferred` 归一为 `codemode` 别名，
 * 新表单只提供四个 canonical 值；旧文件里已有的别名仍能读。
 */
type ExposureLabelKey = "config.mcp.exposure.codemode" | "config.mcp.exposure.deferred" | "config.mcp.exposure.direct" | "config.mcp.exposure.hidden";
const EXPOSURE_OPTIONS: Array<{ value: McpExposure; labelKey: ExposureLabelKey }> = [
	{ value: "codemode", labelKey: "config.mcp.exposure.codemode" },
	{ value: "deferred", labelKey: "config.mcp.exposure.deferred" },
	{ value: "direct", labelKey: "config.mcp.exposure.direct" },
	{ value: "hidden", labelKey: "config.mcp.exposure.hidden" },
];

const TRANSPORT_OPTIONS: Array<{ value: McpServerTransport; labelKey: "config.mcp.transport.stdio" | "config.mcp.transport.http" }> = [
	{ value: "stdio", labelKey: "config.mcp.transport.stdio" },
	{ value: "http", labelKey: "config.mcp.transport.http" },
];

export type McpTabHandle = {
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
};

function blankDefinition(transport: McpServerTransport): McpServerDefinition {
	if (transport === "http") return { url: "https://" };
	return { command: "npx", args: ["-y"] };
}

/** toolExposure 编辑行的稳定草稿（保存时才构建有序对象）。 */
type ToolExposureRow = { rowId: string; pattern: string; exposure: McpExposure };

/** URL 的 userinfo/query 可能含凭据：停用覆盖不能把它们复制进项目层。 */
function urlHasSensitiveParts(url: string): boolean {
	try {
		const parsed = new URL(url);
		return Boolean(parsed.username || parsed.password || parsed.search);
	} catch {
		return false;
	}
}

/**
 * 为「在本层停用继承条目」构造最小有效定义：pi 要求 `enabled:false` 仍带有效传输，
 * 且不复制 headers/env/oauth/auth 等可能含凭据的字段。
 */
function buildInheritedDisableOverride(definition: McpServerDefinition): { definition: McpServerDefinition; sensitive: boolean } {
	if (typeof definition.url === "string" && definition.url.trim()) {
		if (urlHasSensitiveParts(definition.url)) return { definition: { enabled: false }, sensitive: true };
		const next: McpServerDefinition = { url: definition.url, enabled: false };
		if (definition.type === "http" || definition.type === "streamable-http") next.type = definition.type;
		return { definition: next, sensitive: false };
	}
	if (typeof definition.command === "string" && definition.command.trim()) {
		return { definition: { command: definition.command, enabled: false }, sensitive: false };
	}
	return { definition: { enabled: false }, sensitive: false };
}

export const McpTab = forwardRef<
	McpTabHandle,
	{
		/** 未设置 = 全局页；设置 = 项目资源管理器打开的项目作用域。 */
		projectId?: string;
		projectName?: string;
		/** 导入对话框的项目来源：扫描激活项目里的 Claude/Codex MCP 配置（Chat 项目由主进程过滤）。 */
		activeProjectId?: string;
		/** 「去扩展页」由父层导航（本页不掌握 UI 路由），保留当前作用域。 */
		onGoToExtensions?: () => void;
		onDirtyChange: (dirty: boolean) => void;
	}
>(function McpTab(props, ref) {
	const { projectId, projectName, activeProjectId, onDirtyChange } = props;
	/**
	 * 作用域对象：主进程按注册 projectId 解析，渲染层不传路径。
	 * 必须 memo —— 它进 load 的依赖，每次渲染新建对象会让 load 身份变化、effect 重跑，
	 * 用磁盘内容覆盖正在编辑的草稿（表现为“输入的内容自己消失”）。
	 */
	const scope: McpConfigScope | undefined = useMemo(() => (projectId ? { scope: "project", projectId } : undefined), [projectId]);
	/**
	 * 脏回调同样不能进 load 依赖：调用方传内联箭头时身份每次都变，同样会触发重载覆盖草稿。
	 * 用 ref 取最新值，load 不再依赖调用方是否把回调 memo 化。
	 */
	const onDirtyChangeRef = useRef(onDirtyChange);
	useEffect(() => {
		onDirtyChangeRef.current = onDirtyChange;
	}, [onDirtyChange]);
	const isProjectScope = Boolean(projectId);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
	const [writable, setWritable] = useState<McpConfigFile>(EMPTY_FILE);
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ name: string; definition: McpServerDefinition } | null>(null);
	const [probe, setProbe] = useState<McpProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	/** pi mcp list --json 的真实连接状态（「检测连接」按钮触发）。 */
	const [status, setStatus] = useState<McpCliListResult | null>(null);
	const [statusLoading, setStatusLoading] = useState(false);
	const [statusError, setStatusError] = useState<string | null>(null);
	/** 登录进行中的 server 名（同一时间只允许一个登录动作，pi 侧一次只处理一个回调端口）。 */
	const [loggingInServer, setLoggingInServer] = useState<string | null>(null);
	/** 登录过程中捕获的授权 URL（内嵌兑底链接，不弹 toast；见计划 M6）。 */
	const [loginUrl, setLoginUrl] = useState<{ server: string; url: string } | null>(null);
	/** 最近一次登录/登出结果（行内展示 output 尾部；新动作会覆盖）。 */
	const [loginResult, setLoginResult] = useState<{ kind: "login" | "logout"; server: string; ok: boolean; output: string } | null>(null);
	/** 待确认登出的 server：登出会删除同一 URL 共享的凭据，必须二次确认。 */
	const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
	/** 第三方接管型 MCP 扩展（pi-mcp-adapter 等）识别结果；null = 探测失败（横幅降级，不阻塞编辑）。 */
	const [thirdPartyMcp, setThirdPartyMcp] = useState<ThirdPartyMcpExtension[] | null>(null);
	/** auth.json 里已配置的供应商名（供应商登录下拉数据源）；只读键名。 */
	const [knownProviders, setKnownProviders] = useState<string[]>([]);
	const loadGenerationRef = useRef(0);
	/** 当前登录操作的绑定身份：只有同一次操作的 URL 事件才能更新登录区域。 */
	const loginOperationRef = useRef<{ operationId: string; server: string } | null>(null);

	/** 脏状态上报父层（标题栏保存按钮与关闭确认依赖它）。 */
	const markDirty = useCallback(() => onDirtyChangeRef.current(true), []);

	/**
	 * 识别接管型第三方 MCP 扩展（pi-mcp-adapter 等）；失败返回 null 由调用方降级。
	 * pi 0.99 起 mcp.json 由内置 MCP 读取，这类扩展会让内置 MCP 失效，横幅给卸载命令。
	 */
	const probeThirdParty = useCallback(async (): Promise<ThirdPartyMcpExtension[] | null> => {
		try {
			const list = await window.piDesktop.extensions.list();
			return detectThirdPartyMcpExtensions(list.extensions);
		} catch {
			// 扩展 API 不可用时（如预览环境）不阻塞配置浏览或编辑。
			return null;
		}
	}, []);

	const load = useCallback(async () => {
		const generation = ++loadGenerationRef.current;
		setLoading(true);
		setError(null);
		setProbe(null);
		try {
			const thirdPartyState = await probeThirdParty();
			if (generation !== loadGenerationRef.current) return;
			const next = await api.config.getMcp(scope);
			if (generation !== loadGenerationRef.current) return;
			setThirdPartyMcp(thirdPartyState);
			setSnapshot(next);
			setWritable(next.writableFile.mcpServers ? next.writableFile : { ...next.writableFile, mcpServers: {} });
			onDirtyChangeRef.current(false);
			setCreating(null);
			const names = next.servers.map((item) => item.name);
			setSelected((current) => (current && names.includes(current) ? current : (names[0] ?? null)));
		} catch (caught) {
			if (generation === loadGenerationRef.current) {
				// 未信任项目：configGetMcp 项目分支会拒读（正确门禁），裸异常换成引导文案
				setError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
			}
		} finally {
			if (generation === loadGenerationRef.current) setLoading(false);
		}
	}, [probeThirdParty, scope]);

	useEffect(() => {
		void load();
		return () => {
			// A late response after unmount must never replace the current snapshot.
			loadGenerationRef.current += 1;
		};
	}, [load]);

	useEffect(() => {
		let cancelled = false;
		void api.config
			.getAuth()
			.then((auth) => {
				if (cancelled) return;
				setKnownProviders(
					Object.keys(auth.parsed ?? {}).filter((key) => {
						const value = (auth.parsed as Record<string, unknown>)[key];
						return key.trim() !== "" && value !== null && typeof value === "object";
					}),
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	const displayServers = useMemo(() => (snapshot ? buildMcpDisplayServers(snapshot, writable) : []), [snapshot, writable]);
	/** 使用供应商登录（auth.provider）的 server：不使用 MCP OAuth，登录/登出按钮不适用。 */
	const providerAuthServerNames = useMemo(() => new Set(displayServers.filter((item) => usesProviderAuth(item.definition)).map((item) => item.name)), [displayServers]);
	/** 连接状态按名索引（列表行内直接显示状态/工具数/登录入口）。 */
	const statusByName = useMemo(() => Object.fromEntries((status?.servers ?? []).map((server) => [server.name, server])), [status]);

	// 切换 server 或重新加载后清掉 toolExposure 草稿行，避免把上一台的编辑串到下一台。
	useEffect(() => {
		setToolExposureOverride(null);
	}, [selected, creating]);

	const selectedItem = displayServers.find((item) => item.name === selected) ?? null;
	const selectedTemplateDefinition = selectedTemplate ? MCP_SERVICE_CATALOG.find((entry) => entry.id === selectedTemplate) : null;
	const editingDef: McpServerDefinition = creating ? creating.definition : (selectedItem?.definition ?? blankDefinition("stdio"));
	const transport = inferMcpTransport(editingDef);
	/**
	 * 表单的**展示与预选值**用归一后的定义：兼容别名 `codemode-deferred` 不归一就会落到
	 * ConfigSelect 的「自定义」兜底里、把原字符串当档位显示。
	 * 只用于显示/预选：草稿与落盘仍保留原文，不主动改写用户文件。
	 */
	const editingDisplayDef = useMemo(() => resolveExposureAliases(editingDef), [editingDef]);
	/** OAuth 高级参数已从表单移除：仅当定义里预设了这些字段（粘贴/导入）时显示只读提示，原值照常保留。 */
	const hasPresetOAuth = Boolean(editingDef.oauth && Object.keys(editingDef.oauth).length > 0);

	const applyWritable = useCallback(
		(next: McpConfigFile) => {
			setWritable(next);
			markDirty();
		},
		[markDirty],
	);

	const upsert = useCallback(
		(name: string, definition: McpServerDefinition) => {
			applyWritable({
				...writable,
				mcpServers: { ...(writable.mcpServers ?? {}), [name]: definition },
			});
		},
		[applyWritable, writable],
	);

	const startCreate = () => {
		setSelectedTemplate(null);
		setCreating({ name: "", definition: blankDefinition("stdio") });
		setSelected(null);
		setProbe(null);
	};

	/** 智能添加（默认入口）：清空选中让编辑区显示粘贴面板。 */
	const openSmartAdd = () => {
		setCreating(null);
		setSelected(null);
		setSelectedTemplate(null);
		setProbe(null);
	};

	const cancelCreate = () => {
		setCreating(null);
		setSelected(displayServers[0]?.name ?? null);
		setProbe(null);
		// 新建草稿不在 writable 里；取消后若可写层未改，清掉黄点。
		if (snapshot && JSON.stringify(writable) === JSON.stringify(snapshot.writableFile)) {
			onDirtyChangeRef.current(false);
		}
	};

	const patchEditing = (patch: Partial<McpServerDefinition>) => {
		if (creating) {
			setCreating({ ...creating, definition: { ...creating.definition, ...patch } });
			markDirty();
			return;
		}
		if (!selected) return;
		upsert(selected, { ...editingDef, ...patch });
	};

	/** OAuth 子字段变更：全部为空时整键删除，避免落盘 `oauth: {}`。 */
	const patchOauth = (patch: Partial<McpOAuth>) => {
		const current = editingDef.oauth ?? {};
		const next = { ...current, ...patch };
		const hasValue = Object.values(next).some((value) => value !== undefined);
		patchEditing({ oauth: hasValue ? next : undefined });
	};

	/**
	 * toolExposure 编辑行：用稳定的 rowId 作 React key，名称/暴露方式分开编辑，
	 * 保存时才构建有序对象。不能把可编辑名称当 key，否则每个字符输入都会重建行、丢焦点；
	 * 也不能每键入一次就删除重建原 map，对象顺序是 pi 的匹配顺序（首个命中优先）。
	 */
	const toolExposureRows = useMemo<ToolExposureRow[]>(() => {
		const base = editingDisplayDef.toolExposure ?? {};
		return Object.entries(base).map(([pattern, exposure]) => ({ rowId: `row-${pattern}`, pattern, exposure }));
	}, [editingDisplayDef.toolExposure]);
	const [toolExposureOverride, setToolExposureOverride] = useState<ToolExposureRow[] | null>(null);
	const rows = toolExposureOverride ?? toolExposureRows;
	const commitToolExposureRows = (next: ToolExposureRow[]) => {
		setToolExposureOverride(next);
		const trimmed = next.filter((row) => row.pattern.trim().length > 0);
		if (trimmed.length !== next.length) return;
		const record: Record<string, McpExposure> = {};
		for (const row of trimmed) {
			const pattern = row.pattern;
			if (!pattern || pattern in record) return;
			record[pattern] = row.exposure;
		}
		patchEditing({ toolExposure: Object.keys(record).length > 0 ? record : undefined });
	};
	const addToolExposureRow = () => {
		let index = rows.length;
		const taken = new Set(rows.map((row) => row.pattern));
		while (taken.has(`tool_${index}`)) index += 1;
		setToolExposureOverride([...rows, { rowId: `new-${Date.now()}-${index}`, pattern: `tool_${index}`, exposure: "direct" }]);
	};

	const switchTransport = (next: McpServerTransport) => {
		const kept = {
			exposure: editingDef.exposure,
			enabled: editingDef.enabled,
			timeout: editingDef.timeout,
			env: editingDef.env,
			headers: editingDef.headers,
			oauth: editingDef.oauth,
		};
		const nextDef = { ...blankDefinition(next), ...kept };
		if (creating) {
			setCreating({ ...creating, definition: nextDef });
			markDirty();
			return;
		}
		if (selected) upsert(selected, nextDef);
	};

	/**
	 * 在本层停用/启用一个条目。
	 * - 本层已有条目：停用写 `enabled:false`、启用**删键**（pi 自己的 updateMcpServerConfig 就是这样）。
	 * - 继承自其他层（项目页里来自全局）：停用写「有效的最小停用定义」——必须有有效传输，
	 *   因为 pi 对 `{enabled:false}` 这种无传输条目直接判非法并跳过；不复制 headers/env/oauth/auth 凭据。
	 */
	/** 启停开关：立即落盘（与智能添加/删除同语义，所见即所得），成功后自动重检让状态行立刻反映。
	 * 历史缺陷：只写草稿等顶部保存，用户切开关后状态行不变，感知为「开了没反应/再也开不回来」。 */
	const toggleDisabled = async (item: McpServerListItem, disabled: boolean) => {
		const existing = writable.mcpServers?.[item.name];
		let next: McpConfigFile | null = null;
		if (existing) {
			next = { ...writable, mcpServers: { ...(writable.mcpServers ?? {}), [item.name]: applyEnabledToggle(existing, disabled) } };
		} else if (disabled) {
			const inherit = buildInheritedDisableOverride(item.definition);
			if (inherit.sensitive) {
				setError(t("config.mcp.inherited.sensitiveUrl"));
				return;
			}
			next = { ...writable, mcpServers: { ...(writable.mcpServers ?? {}), [item.name]: inherit.definition } };
		} else {
			// 纯继承条目在本层没有覆盖，「启用」无操作对象（本层停用才有意义）
			return;
		}
		applyWritable(next);
		const saved = await persistServers(next);
		if (saved) void runStatusCheck();
	};

	/** 撤销「待删除」：把磁盘上的原定义放回草稿；若草稿因此与磁盘一致则清除脏标记。 */
	const undoDelete = () => {
		if (!selected || !snapshot) return;
		const original = snapshot.writableFile.mcpServers?.[selected];
		if (!original) return;
		const restored = { ...(writable.mcpServers ?? {}), [selected]: original };
		setWritable({ ...writable, mcpServers: restored });
		if (JSON.stringify({ ...writable, mcpServers: restored }) === JSON.stringify(snapshot.writableFile)) {
			onDirtyChangeRef.current(false);
		} else {
			markDirty();
		}
	};

	const removeSelected = () => {
		if (!selected) return;
		const item = selectedItem;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		if (item?.ownedByWritable) {
			// 本层定义：真正删除条目（项目页删除覆盖后重新继承全局定义）。
			delete nextServers[selected];
			applyWritable({ ...writable, mcpServers: nextServers });
		} else if (item) {
			// 继承条目：入口按钮是「恢复继承」/「在本项目停用」，不在这里静默改其他层。
			const inherit = buildInheritedDisableOverride(item.definition);
			if (inherit.sensitive) {
				setError(t("config.mcp.inherited.sensitiveUrl"));
				return;
			}
			upsert(selected, inherit.definition);
		}
		const remaining = displayServers.filter((entry) => entry.name !== selected);
		setSelected(remaining[0]?.name ?? null);
		setProbe(null);
	};

	/** 恢复继承：删除本层同名覆盖，重新使用下层定义。 */
	const restoreInherited = () => {
		if (!selected || !snapshot) return;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		if (!(selected in nextServers)) return;
		delete nextServers[selected];
		applyWritable({ ...writable, mcpServers: nextServers });
		const inherited = snapshot.servers.find((entry) => entry.name === selected);
		setSelected(inherited ? selected : (displayServers.find((entry) => entry.name !== selected)?.name ?? null));
		setProbe(null);
	};

	/** 继承条目在本层是否已有覆盖（用于显示「恢复继承」）。 */
	const hasLocalOverride = Boolean(selected && writable.mcpServers && selected in writable.mcpServers);

	const runProbe = async () => {
		setProbing(true);
		setProbe(null);
		try {
			setProbe(await api.config.probeMcp(editingDef));
		} catch (caught) {
			setProbe({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
		} finally {
			setProbing(false);
		}
	};

	/** 有未保存草稿时不允许运行检测/登录：CLI 读的是磁盘配置，不能显示草稿的结果。 */
	const blockedByDraft = (): boolean => {
		const dirty = Boolean(snapshot && JSON.stringify(writable) !== JSON.stringify(snapshot.writableFile)) || Boolean(creating);
		if (dirty) setStatusError(t("config.mcp.draftBlocked"));
		return dirty;
	};

	/** 真实连接检测：spawn `pi mcp list --json`（exit 1 不算失败，stdout 仍是合法报告）。 */
	const runStatusCheck = async () => {
		if (blockedByDraft()) return;
		setStatusLoading(true);
		setStatusError(null);
		try {
			setStatus(await api.config.mcpListStatus(scope));
		} catch (caught) {
			setStatus(null);
			setStatusError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
		} finally {
			setStatusLoading(false);
		}
	};

	/** OAuth 登录：授权 URL 经 onMcpLoginUrl 推送（内嵌在按钮行里），成功后刷新状态。 */
	const runLogin = async (server: string) => {
		if (blockedByDraft()) return;
		// 每次登录一个独立 operationId：迟到/跨作用域的结果不会覆盖当前登录区域。
		const operationId = `mcp-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		loginOperationRef.current = { operationId, server };
		setLoggingInServer(server);
		setLoginUrl(null);
		const unsubscribe = api.config.onMcpLoginUrl((payload) => {
			const expected = loginOperationRef.current;
			if (!expected || payload.operationId !== expected.operationId) return;
			if (payload.server === server) setLoginUrl(payload);
		});
		try {
			const result = await api.config.mcpLogin(server, 240, scope, operationId);
			if (result.ok) {
				// 凭据生效时机（pi 行为）：运行中的会话不会立刻重连，下一轮对话自动使用新凭据。
				showNotice(t("config.mcp.oauth.loginOk"), 5000, "info");
				await runStatusCheck();
			}
			setLoginResult({ kind: "login", server, ok: result.ok, output: result.output });
		} catch (caught) {
			setLoginResult({ kind: "login", server, ok: false, output: caught instanceof Error ? caught.message : String(caught) });
		} finally {
			unsubscribe();
			if (loginOperationRef.current?.operationId === operationId) loginOperationRef.current = null;
			setLoggingInServer(null);
			setLoginUrl(null);
		}
	};

	const runLogout = async (server: string) => {
		try {
			const result = await api.config.mcpLogout(server, scope);
			setLoginResult({ kind: "logout", server, ok: result.ok, output: result.output });
			if (result.ok) await runStatusCheck();
		} catch (caught) {
			setLoginResult({ kind: "logout", server, ok: false, output: caught instanceof Error ? caught.message : String(caught) });
		}
	};

	/** 统一落盘入口：显式接收待写内容（智能添加在 setState 后立刻保存，不能用闭包里的旧 writable）。 */
	const persistServers = useCallback(
		async (toSave: McpConfigFile): Promise<boolean> => {
			if (snapshot?.writableError) {
				setError(t("config.mcp.writableBroken"));
				return false;
			}
			setSaving(true);
			setError(null);
			try {
				const result = await api.config.saveMcp(toSave, scope, snapshot?.revision);
				if (!result.valid) {
					if (result.conflict) {
						// 乐观锁：磁盘上的 mcp.json 被外部改过（pi/手改/其它窗口），必须以磁盘为准。
						setError(t("config.mcp.conflict"));
						await load();
						return false;
					}
					setError(result.error ?? t("config.saveFailed"));
					return false;
				}
				await load();
				return true;
			} catch (caught) {
				setError(caught instanceof Error ? caught.message : String(caught));
				return false;
			} finally {
				setSaving(false);
			}
		},
		[load, scope, snapshot?.writableError],
	);

	/** 智能添加：写入草稿 → 立即落盘（乐观锁保护）→ 自动跑一次真实连接检测（B 片状态卡的数据源）。 */
	const handleSmartAdd = useCallback(
		async (entries: SmartAddEntry[]): Promise<boolean> => {
			if (entries.length === 0) return false;
			const nextServers = { ...(writable.mcpServers ?? {}) };
			for (const entry of entries) nextServers[entry.name] = entry.definition;
			const toSave: McpConfigFile = { ...writable, mcpServers: nextServers };
			applyWritable(toSave);
			const ok = await persistServers(toSave);
			if (ok) void runStatusCheck();
			return ok;
		},
		[applyWritable, persistServers, runStatusCheck, writable],
	);

	const handleTemplateConnect = useCallback(
		async (entry: SmartAddEntry) => {
			const saved = await handleSmartAdd([entry]);
			if (saved) {
				setSelected(entry.name);
				setSelectedTemplate(null);
			}
			return saved;
		},
		[handleSmartAdd],
	);

	const save = useCallback(async (): Promise<boolean> => {
		const toSave: McpConfigFile = {
			...writable,
			mcpServers: { ...(writable.mcpServers ?? {}) },
		};
		if (creating) {
			const name = creating.name.trim();
			if (!name) {
				setError(t("config.mcp.nameRequired"));
				return false;
			}
			if (!isMcpServerName(name)) {
				setError(t("config.mcp.nameInvalid"));
				return false;
			}
			// 与已合并列表或可写层撞名时拒绝，避免覆盖已有服务。
			if (displayServers.some((item) => item.name === name) || Boolean(toSave.mcpServers?.[name])) {
				setError(t("config.mcp.nameDuplicate"));
				return false;
			}
			toSave.mcpServers = { ...toSave.mcpServers, [name]: creating.definition };
		}
		const ok = await persistServers(toSave);
		if (ok && creating?.name.trim()) setSelected(creating.name.trim());
		return ok;
	}, [creating, displayServers, persistServers, writable]);

	useImperativeHandle(ref, () => ({ save, reload: load }), [save, load]);

	const layerLabel = useMemo(
		() => ({
			"pi-agent": t("config.mcp.layer.piAgent"),
			"project-pi": t("config.mcp.layer.projectPi"),
		}),
		[],
	);

	if (loading && !snapshot) {
		return (
			<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<strong>{t("config.nav.mcp")}</strong>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.mcp.hint")}</p>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.restartHint")}</p>
					<a href={MCP_DOCS} className="mt-1 inline-block text-micro text-primary hover:underline" onClick={openDocsInSystemBrowser(MCP_DOCS)}>
						{t("config.mcp.docs")}
					</a>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
						<RefreshCw size={14} />
						{t("common.refresh")}
					</Button>
					<ResourceImportDialog kind="mcp" sourceProjectId={activeProjectId} triggerLabel={t("config.import.button")} onImported={() => void load()} />
					<Button size="sm" onClick={openSmartAdd} disabled={saving || Boolean(creating)}>
						<Plus size={14} />
						{t("config.mcp.add")}
					</Button>
				</div>
			</div>

			{error ? <div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{error}</div> : null}
			{snapshot?.writableError ? <div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{t("config.mcp.writableBroken")}</div> : null}

			{thirdPartyMcp !== null && thirdPartyMcp.length > 0 ? (
				// 第三方接管型 MCP 扩展横幅：一句话后果 + 一句可复制卸载命令（计划 M5 文案口径）。
				thirdPartyMcp.map((item) => (
					<div key={item.source} className="rounded-md border border-[var(--color-warning,#d97706)]/40 bg-[color-mix(in_srgb,var(--color-warning,#d97706)_8%,var(--color-bg-panel))] px-3 py-2">
						<div className="flex items-center gap-1.5 text-control font-medium">
							<TriangleAlert size={14} className="text-[var(--color-warning,#d97706)]" />
							{item.enabled ? t("config.mcp.thirdParty.title", { source: item.source }) : t("config.mcp.thirdParty.titleDisabled", { source: item.source })}
						</div>
						<p className="mt-1 text-micro text-muted-foreground">{item.enabled ? t("config.mcp.thirdParty.desc") : t("config.mcp.thirdParty.descDisabled")}</p>
						<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
							{item.isLocalFile ? (
								<span className="font-mono text-micro text-muted-foreground">{t("config.mcp.thirdParty.localFileHint")}</span>
							) : (
								<>
									<code className="rounded-sm border border-border-subtle bg-bg-hover px-2 py-1 font-mono text-micro">{item.uninstallCommand}</code>
									<Button variant="outline" size="xs" onClick={() => void window.piDesktop.clipboard.writeText(item.uninstallCommand)}>
										{t("config.mcp.thirdParty.copyCommand")}
									</Button>
								</>
							)}
							<Button variant="ghost" size="xs" onClick={() => props.onGoToExtensions?.()}>
								{t("config.mcp.thirdParty.goToExtensions")}
							</Button>
						</div>
					</div>
				))
			) : thirdPartyMcp === null ? (
				// 扩展列表探测失败：不阻塞配置区，仅提示。
				<p className="text-micro text-muted-foreground">{t("config.mcp.thirdParty.detectFailed")}</p>
			) : null}

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1">
				<div className="flex min-h-0 flex-col gap-1.5">
					<McpServerListPane
						servers={displayServers}
						selected={selected}
						creating={Boolean(creating)}
						onSelect={(name) => {
							setSelected(name);
							setSelectedTemplate(null);
							setProbe(null);
						}}
						selectedTemplate={selectedTemplate}
						onSelectTemplate={(templateId) => {
							setCreating(null);
							setSelected(null);
							setSelectedTemplate(templateId);
							setProbe(null);
						}}
						statusByName={statusByName}
						credentialNames={new Set(snapshot?.oauthCredentialNames ?? [])}
						providerAuthNames={providerAuthServerNames}
						loggingInServer={loggingInServer}
						onLogin={(name) => void runLogin(name)}
						onLogout={(name) => setLogoutConfirm(name)}
						onRefreshStatus={() => void runStatusCheck()}
						statusLoading={statusLoading}
					/>
				</div>

				<div className="flex min-h-0 flex-col gap-3 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-3">
					{selectedTemplateDefinition ? (
						<McpServiceTemplateForm key={selectedTemplateDefinition.id} entry={selectedTemplateDefinition} existingNames={new Set(displayServers.map((item) => item.name))} disabled={saving || loading} saving={saving} onConnect={handleTemplateConnect} onCustom={openSmartAdd} />
					) : !selected && !creating ? (
						<McpSmartAdd existingNames={new Set(displayServers.map((item) => item.name))} disabled={saving} onAdd={handleSmartAdd} onManual={startCreate} onInstallAiSetupSkill={async () => (await api.config.installMcpSetupSkill()).success} />
					) : (
						<>
							{selectedItem?.pendingDelete ? (
								<div className="flex flex-wrap items-center gap-2 rounded-sm border border-border-subtle bg-bg-hover px-2.5 py-2 text-micro text-muted-foreground">
									<span>{t("config.mcp.pendingDeleteNotice")}</span>
									<Button variant="outline" size="xs" onClick={undoDelete} disabled={saving}>
										{t("config.mcp.undoDelete")}
									</Button>
								</div>
							) : null}
							{creating ? (
								<button type="button" className="self-start text-micro text-primary hover:underline" onClick={openSmartAdd}>
									← {t("config.mcp.smartAdd.back")}
								</button>
							) : null}

							{/* ═══ 第一段：基本信息 ═══ */}
							<div className="rounded-md border border-border-subtle p-3">
								<div className="mb-2 text-control font-medium">{t("config.mcp.section.basic")}</div>
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.name")}</Label>
									<Input
										value={creating ? creating.name : (selected ?? "")}
										onChange={(event) => {
											if (!creating) return;
											setCreating({ ...creating, name: event.target.value });
											markDirty();
										}}
										disabled={!creating || saving}
										placeholder="chrome-devtools"
										className="h-8 font-mono"
									/>
								</div>
								<div className="mt-2 grid gap-2">
									<Label>{t("config.mcp.field.transport")}</Label>
									<ConfigSelect value={transport} options={TRANSPORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(value) => switchTransport(value as McpServerTransport)} />
								</div>
								{transport === "stdio" ? (
									<>
										<div className="mt-2 grid gap-2">
											<Label>{t("config.mcp.field.command")}</Label>
											<Input value={editingDef.command ?? ""} onChange={(event) => patchEditing({ command: event.target.value, url: undefined })} className="h-8 font-mono" placeholder="npx" />
										</div>
										<div className="mt-2 grid gap-2">
											<Label>{t("config.mcp.field.args")}</Label>
											<Input value={argsToText(editingDef.args)} onChange={(event) => patchEditing({ args: textToArgs(event.target.value) })} className="h-8 font-mono" placeholder="-y chrome-devtools-mcp@1.6.0" />
										</div>
									</>
								) : (
									<div className="mt-2 grid gap-2">
										<Label>{t("config.mcp.field.url")}</Label>
										<Input
											value={editingDef.url ?? ""}
											onChange={(event) => patchEditing({ url: event.target.value, command: undefined, args: undefined })}
											onFocus={(event) => {
												if (event.currentTarget.value === "https://") event.currentTarget.select();
											}}
											className="h-8 font-mono"
											placeholder="https://mcp.example.com/mcp"
										/>
									</div>
								)}
							</div>

							{/* ═══ 第二段：连接与认证 ═══ */}
							<div className="rounded-md border border-border-subtle p-3">
								<div className="mb-2 flex items-center justify-between gap-2">
									<div className="text-control font-medium">{t("config.mcp.section.auth")}</div>
									<Button variant="outline" size="xs" onClick={() => void runStatusCheck()} disabled={statusLoading || saving}>
										<RefreshCw size={12} className={statusLoading ? "animate-pideck-spin" : ""} />
										{statusLoading ? t("config.mcp.status.checking") : t("config.mcp.status.check")}
									</Button>
								</div>
								{/* 选中 server 的状态行 */}
								{selected && statusByName[selected] ? (
									<div className="flex flex-wrap items-center gap-2 text-control">
										<span
											className={`size-1.5 shrink-0 rounded-full ${statusByName[selected].state === "connected" ? "bg-[var(--color-success)]" : statusByName[selected].state === "needs-auth" ? "bg-[var(--color-warning,#d97706)]" : statusByName[selected].state === "disabled" ? "bg-muted-foreground" : "bg-danger"}`}
											aria-hidden="true"
										/>
										<span className="text-micro">
											{statusByName[selected].state === "connected"
												? t("config.mcp.status.connected", { count: statusByName[selected].tools.length })
												: statusByName[selected].state === "needs-auth"
													? t("config.mcp.status.needsAuth")
													: statusByName[selected].state === "disabled"
														? t("config.mcp.status.disabled")
														: t("config.mcp.status.disconnected")}
										</span>
										{statusByName[selected].error ? <p className="w-full break-all text-micro text-danger">{statusByName[selected].error}</p> : null}
									</div>
								) : (
									<p className="text-micro text-muted-foreground">{t("config.mcp.status.notTested")}</p>
								)}
								{/* 登录/登出操作行：OAuth 型服务（远程 HTTP、无静态 Authorization 头、非供应商登录）。出口规则：有凭据→登出；
								 检测出 needs-auth/disconnected→登录；disabled（停用）不显示——先启用再登录才是正常顺序，
								 公共服务停用时挂登录按钮纯属困惑；未检测也不显示——公共服务（beui）与需登录服务无法区分。 */}
								{selected && usesMcpOAuth(editingDef) && !providerAuthServerNames.has(selected) && ((snapshot?.oauthCredentialNames ?? []).includes(selected) || ["needs-auth", "disconnected"].includes(statusByName[selected]?.state ?? "")) ? (
									<div className="mt-2 flex flex-wrap items-center gap-2">
										{(snapshot?.oauthCredentialNames ?? []).includes(selected) ? (
											<Button variant="ghost" size="xs" onClick={() => setLogoutConfirm(selected)}>
												<LogOut size={12} />
												{t("config.mcp.oauth.logout")}
											</Button>
										) : loggingInServer === selected ? (
											<span className="text-micro text-muted-foreground">{t("config.mcp.oauth.loggingIn")}</span>
										) : (
											<Button variant="outline" size="xs" onClick={() => void runLogin(selected)}>
												<LogIn size={12} />
												{t("config.mcp.oauth.login")}
											</Button>
										)}
									</div>
								) : null}
								{/* 登录过程信息（只针对当前选中的 server，与状态行同区）：
								 登录中给「复制链接」手动打开的出口；结果行只显示结构化摘要，
								 pi CLI 原始输出（含超长授权 URL）不直接上屏。 */}
								{loggingInServer === selected ? (
									<div className="mt-2 grid gap-1.5">
										<p className="text-micro text-muted-foreground">{t("config.mcp.oauth.browserOpened")}</p>
										{loginUrl && loginUrl.server === selected ? (
											<div className="flex flex-wrap items-center gap-1.5">
												<Button
													variant="outline"
													size="xs"
													onClick={() => {
														void window.piDesktop.clipboard.writeText(loginUrl.url);
														showNotice(t("common.copied"), 1500, "info");
													}}
												>
													<Copy size={12} />
													{t("config.mcp.oauth.copyLink")}
												</Button>
												<a href={loginUrl.url} className="text-micro text-primary hover:underline" onClick={openDocsInSystemBrowser(loginUrl.url)}>
													{t("config.mcp.oauth.openAuthLink")}
												</a>
											</div>
										) : null}
									</div>
								) : null}
								{loginResult && loginResult.server === selected && (!loginResult.ok || loginResult.kind === "logout") ? (
									<p className={`mt-2 break-all text-micro ${loginResult.ok ? "text-[var(--color-success)]" : "text-danger"}`}>{loginResult.ok ? t("config.mcp.oauth.signedOut") : sanitizeLoginOutput(loginResult.output) || t("config.mcp.oauth.failed")}</p>
								) : null}
								{transport === "http" && usesProviderAuth(editingDef) ? <p className="mt-2 text-micro text-muted-foreground">{t("config.mcp.providerAuth.hint", { provider: editingDef.auth?.provider ?? "" })}</p> : null}
							</div>

							{/* ═══ 第三段：启用 ═══ */}
							<div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle p-3">
								<div>
									<div className="text-control font-medium">{t("config.mcp.field.enabled")}</div>
									<div className="text-micro text-muted-foreground">{t("config.mcp.field.enabledHint")}</div>
								</div>
								<Switch
									checked={!isMcpServerDisabled(editingDef)}
									onCheckedChange={(checked) => {
										if (creating) {
											if (checked) {
												const { enabled: _ignored, ...kept } = creating.definition as McpServerDefinition;
												setCreating({ ...creating, definition: kept });
											} else {
												patchEditing({ enabled: false });
											}
											markDirty();
											return;
										}
										if (selectedItem) void toggleDisabled(selectedItem, !checked);
									}}
								/>
							</div>

							{/* ═══ 第四段：高级（折叠） ═══ */}
							<Collapsible>
								<CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md border border-border-subtle px-3 py-2 text-control text-muted-foreground hover:bg-bg-hover [&[data-state=open]>svg]:rotate-90">
									<ChevronRight size={14} className="transition-transform" />
									{t("config.mcp.section.advanced")}
								</CollapsibleTrigger>
								<CollapsibleContent>
									<div className="mt-1 grid gap-3 rounded-md border border-border-subtle p-3">
										{transport === "http" && !isProjectScope ? (
											<div className="grid gap-2">
												<Label>{t("config.mcp.providerAuth.provider")}</Label>
												<ConfigSelect
													value={editingDef.auth?.provider ?? ""}
													options={[{ value: "", label: t("config.mcp.providerAuth.none") }, ...knownProviders.map((provider) => ({ value: provider, label: provider }))]}
													onChange={(provider) => {
														const auth = { ...editingDef.auth };
														if (provider) auth.provider = provider;
														else delete auth.provider;
														patchEditing({ auth: Object.keys(auth).length > 0 ? auth : undefined });
													}}
												/>
												{knownProviders.length === 0 ? <p className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.emptyHint")}</p> : null}
												{usesProviderAuth(editingDef) ? <p className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.hint", { provider: editingDef.auth?.provider ?? "" })}</p> : null}
												<p className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.advancedHint")}</p>
											</div>
										) : transport === "http" && isProjectScope && usesProviderAuth(editingDef) ? (
											<p className="text-micro text-muted-foreground">{t("config.mcp.providerAuth.hint", { provider: editingDef.auth?.provider ?? "" })}</p>
										) : null}
										{transport === "http" ? (
											<div className="grid gap-2">
												<Label>{t("config.mcp.field.headers")}</Label>
												<Textarea value={recordToText(editingDef.headers)} onChange={(event) => patchEditing({ headers: textToRecord(event.target.value) })} placeholder={t("config.mcp.field.headersPlaceholder")} className="min-h-20 font-mono text-control" />
												<p className="text-micro text-muted-foreground">{t("config.mcp.secretStorageHint")}</p>
											</div>
										) : (
											<div className="grid gap-2">
												<Label>{t("config.mcp.field.env")}</Label>
												<Textarea value={recordToText(editingDef.env)} onChange={(event) => patchEditing({ env: textToRecord(event.target.value) })} placeholder="API_KEY=your-key" className="min-h-20 font-mono text-control" />
												<p className="text-micro text-muted-foreground">{t("config.mcp.secretStorageHint")}</p>
											</div>
										)}
										<div className="grid gap-2">
											<Label>{t("config.mcp.field.exposure")}</Label>
											<ConfigSelect value={editingDisplayDef.exposure ?? "codemode"} options={EXPOSURE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(value) => patchEditing({ exposure: value as McpExposure })} />
											<p className="text-micro text-muted-foreground">{t("config.mcp.exposureHint")}</p>
										</div>
										<div className="rounded-sm border border-border-subtle p-2.5">
											<div className="flex items-center justify-between gap-2">
												<div>
													<div className="text-control font-medium">{t("config.mcp.toolExposure.section")}</div>
													<p className="mt-0.5 text-micro text-muted-foreground">{t("config.mcp.toolExposure.sectionHint")}</p>
												</div>
												<Button variant="outline" size="xs" onClick={addToolExposureRow}>
													<Plus size={13} />
													{t("config.mcp.toolExposure.add")}
												</Button>
											</div>
											{rows.map((row) => (
												<div key={row.rowId} className="mt-2 flex items-center gap-1.5">
													<Input value={row.pattern} onChange={(event) => commitToolExposureRows(rows.map((entry) => (entry.rowId === row.rowId ? { ...entry, pattern: event.target.value } : entry)))} className="h-8 min-w-0 flex-1 font-mono" placeholder="get_*" />
													<ConfigSelect
														value={row.exposure}
														options={EXPOSURE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
														onChange={(value) => commitToolExposureRows(rows.map((entry) => (entry.rowId === row.rowId ? { ...entry, exposure: value as McpExposure } : entry)))}
														triggerClassName="w-36 shrink-0"
													/>
													<Button
														variant="ghost"
														size="icon-sm"
														className="size-7 shrink-0 text-muted-foreground"
														onClick={() => {
															const next = rows.filter((entry) => entry.rowId !== row.rowId);
															setToolExposureOverride(next.length > 0 ? next : null);
															patchEditing({ toolExposure: next.length > 0 ? Object.fromEntries(next.map((entry) => [entry.pattern, entry.exposure])) : undefined });
														}}
														title={t("common.delete")}
													>
														<Trash2 size={13} />
													</Button>
												</div>
											))}
											{rows.length === 0 ? <p className="mt-1.5 text-micro text-muted-foreground">{t("config.mcp.toolExposure.empty")}</p> : null}
										</div>
										<div className="grid gap-2">
											<Label>{t("config.mcp.field.timeout")}</Label>
											<Input
												value={editingDef.timeout === undefined ? "" : String(editingDef.timeout)}
												onChange={(event) => {
													const raw = event.target.value.trim();
													if (raw === "") {
														patchEditing({ timeout: undefined });
														return;
													}
													const parsed = Number(raw);
													if (Number.isFinite(parsed) && parsed > 0) patchEditing({ timeout: parsed });
												}}
												className="h-8 font-mono"
												placeholder="60"
												inputMode="numeric"
											/>
											<p className="text-micro text-muted-foreground">{t("config.mcp.timeoutHint")}</p>
										</div>
										{transport === "stdio" ? (
											<div className="grid gap-2">
												<Label>{t("config.mcp.field.cwd")}</Label>
												<Input value={editingDef.cwd ?? ""} onChange={(event) => patchEditing({ cwd: event.target.value || undefined })} className="h-8 font-mono" />
											</div>
										) : null}
									</div>
								</CollapsibleContent>
							</Collapsible>

							{/* ═══ 操作按钮 ═══ */}
							<div className="flex flex-wrap items-center gap-1.5">
								<Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing || saving}>
									<PlugZap size={14} />
									{probing ? t("config.mcp.probing") : t("config.mcp.probe")}
								</Button>
								{creating ? (
									<Button variant="ghost" size="sm" onClick={cancelCreate}>
										{t("common.cancel")}
									</Button>
								) : selectedItem?.pendingDelete ? (
									<Button variant="outline" size="sm" onClick={undoDelete} disabled={saving}>
										{t("config.mcp.undoDelete")}
									</Button>
								) : (
									<Button variant="outline" size="sm" className="text-destructive" onClick={removeSelected} disabled={saving}>
										<Trash2 size={13} />
										{selectedItem?.ownedByWritable ? t("common.delete") : t("config.mcp.disableInstead")}
									</Button>
								)}
							</div>
							{probe ? <div className={`rounded-sm border px-2.5 py-2 text-micro ${probe.ok ? "border-[var(--color-success)]/30 text-[var(--color-success)]" : "border-danger/20 text-danger"}`}>{probe.ok ? `${t("config.mcp.probeOk")} · ${probe.detail}` : `${t("config.mcp.probeFail")} · ${probe.error}`}</div> : null}
							{selectedItem && !creating ? (
								<p className="text-micro text-muted-foreground" title={selectedItem.originPath}>
									{t("config.mcp.origin")}: {selectedItem.originPath}
									{selectedItem.ownedByWritable ? "" : ` · ${t("config.mcp.inheritedHint")}`}
								</p>
							) : null}
							{isProjectScope && selectedItem && !creating && !selectedItem.ownedByWritable ? (
								<div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-bg-hover px-2.5 py-2">
									<Button variant="outline" size="xs" onClick={() => toggleDisabled(selectedItem, true)} disabled={saving}>
										{t("config.mcp.disableInherited")}
									</Button>
									<Button variant="ghost" size="xs" onClick={restoreInherited} disabled={saving || !hasLocalOverride}>
										{t("config.mcp.restoreInherited")}
									</Button>
								</div>
							) : null}
						</>
					)}
				</div>
			</div>
			{logoutConfirm ? (
				<ConfirmDialog
					title={t("config.mcp.oauth.logoutConfirmTitle")}
					message={t("config.mcp.oauth.logoutConfirmBody", { name: logoutConfirm })}
					confirmLabel={t("config.mcp.oauth.logout")}
					danger
					onConfirm={() => {
						const server = logoutConfirm;
						setLogoutConfirm(null);
						void runLogout(server);
					}}
					onCancel={() => setLogoutConfirm(null)}
				/>
			) : null}
		</div>
	);
});
