/**
 * Pi 配置管理 → MCP 页。
 * 只编辑 pi-mcp-adapter 读取的 mcp.json（可写层 ~/.pi/agent/mcp.json），
 * 不启动 MCP 运行时；探测仅检查 command 是否在 PATH / HTTP 是否可达。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Plus, Trash2, PlugZap, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import { Label } from "../components/ui-shadcn/label";
import { Textarea } from "../components/ui-shadcn/textarea";
import { ConfigSelect, openDocsInSystemBrowser } from "./ConfigShared";
import { ResourceScopeSelector, type ResourceScope } from "./ResourceScopeSelector";
import {
	inferMcpTransport,
	isMcpServerDisabled,
	McpAdapterGuide,
	McpServerListPane,
} from "./McpResourceViews";
import {
	argsToText,
	buildMcpDisplayServers,
	isMcpServerName,
	recordToText,
	textToArgs,
	textToRecord,
} from "./mcpForm";
import type {
	McpConfigFile,
	McpConfigSnapshot,
	McpProbeResult,
	McpServerDefinition,
	McpServerListItem,
	McpServerTransport,
} from "../../../shared/types/mcp";

const api = (window as unknown as { piDesktop: {
	config: {
		getMcp: (projectId?: string) => Promise<McpConfigSnapshot>;
		saveMcp: (data: McpConfigFile) => Promise<{ valid: boolean; error?: string }>;
		probeMcp: (definition: McpServerDefinition) => Promise<McpProbeResult>;
	};
} }).piDesktop;

const MCP_DOCS = "https://nicobailon-pi-mcp-adapter.mintlify.app/configuration/server-setup";
const EMPTY_FILE: McpConfigFile = { mcpServers: {} };

const LIFECYCLE_OPTIONS = [
	{ value: "lazy", labelKey: "config.mcp.lifecycle.lazy" as const },
	{ value: "eager", labelKey: "config.mcp.lifecycle.eager" as const },
	{ value: "keep-alive", labelKey: "config.mcp.lifecycle.keepAlive" as const },
	{ value: "lazy-keep-alive", labelKey: "config.mcp.lifecycle.lazyKeepAlive" as const },
];

const TRANSPORT_OPTIONS: Array<{ value: McpServerTransport; labelKey: "config.mcp.transport.stdio" | "config.mcp.transport.http" | "config.mcp.transport.socket" }> = [
	{ value: "stdio", labelKey: "config.mcp.transport.stdio" },
	{ value: "http", labelKey: "config.mcp.transport.http" },
	{ value: "socket", labelKey: "config.mcp.transport.socket" },
];

export type McpTabHandle = {
	save: () => Promise<boolean>;
	reload: () => Promise<void>;
};

const ADAPTER_EXTENSION_ID = "pi-mcp-adapter";

function blankDefinition(transport: McpServerTransport): McpServerDefinition {
	if (transport === "http") return { url: "https://", lifecycle: "lazy" };
	if (transport === "socket") return { socket: "", lifecycle: "lazy" };
	return { command: "npx", args: ["-y"], lifecycle: "lazy" };
}

export const McpTab = forwardRef<McpTabHandle, {
	/** PiDeck 已加载项目（项目作用域下拉数据源）；Chat 项目由选择器过滤。 */
	projects?: Array<{ id: string; name: string; kind?: string }>;
	/** 当前激活项目 id：项目作用域默认选中并跟随激活项目变化。 */
	activeProjectId?: string;
	onDirtyChange: (dirty: boolean) => void;
}>(function McpTab(props, ref) {
	const { projects = [], activeProjectId, onDirtyChange } = props;
	/**
	 * MCP 页自持作用域：项目级 mcp.json 只有这里能管理（项目右键的资源弹窗不含 MCP），
	 * 因此保留全局/项目切换；技能/扩展/提示词页的作用域下拉已按产品决策移除。
	 */
	const [scope, setScope] = useState<ResourceScope>("global");
	/** 项目作用域下下拉中选中的项目 id（默认激活项目，可切换任意已加载项目）。 */
	const [scopeProjectId, setScopeProjectId] = useState<string | undefined>(activeProjectId);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
	const [writable, setWritable] = useState<McpConfigFile>(EMPTY_FILE);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ name: string; definition: McpServerDefinition } | null>(null);
	const [probe, setProbe] = useState<McpProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	/** pi-mcp-adapter 扩展是否已安装；null = 探测失败/不可用（不阻塞编辑，预览环境等场景降级）。 */
	const [adapterInstalled, setAdapterInstalled] = useState<boolean | null>(null);
	const loadGenerationRef = useRef(0);

	/** 有未保存草稿时禁用作用域切换：切作用域会整页重载并丢弃草稿。 */
	const [dirty, setDirty] = useState(false);
	/** 脏状态同步：既上报父层（标题栏保存按钮/关闭确认），也留在本地控制下拉禁用。 */
	const syncDirty = useCallback((next: boolean) => {
		setDirty(next);
		onDirtyChange(next);
	}, [onDirtyChange]);

	useEffect(() => {
		// 跟随激活项目：侧栏切换项目时下拉选中项同步（仅影响 project 作用域的目标项目）。
		setScopeProjectId(activeProjectId);
	}, [activeProjectId]);

	/** 项目作用域实际使用的项目 id：过滤 Chat 项目（无项目级 mcp.json）；全局作用域为 undefined。 */
	const effectiveProjectId = useMemo(
		() => scope === "project"
			? projects.find((item) => item.id === scopeProjectId && item.kind !== "chat")?.id
			: undefined,
		[scope, projects, scopeProjectId],
	);
	/** 无可用项目时不允许停留在 project 作用域（与旧全局选择器的自动回退行为一致）。 */
	const effectiveScope: ResourceScope = scope === "project" && effectiveProjectId ? "project" : "global";

	/** 作用域下拉：全局 / 项目级 mcp.json 切换；有草稿时禁用。 */
	const scopeSelector = (
		<ResourceScopeSelector
			value={effectiveScope}
			projects={projects}
			selectedProjectId={scopeProjectId}
			disabled={dirty}
			onChange={(nextScope, nextProjectId) => {
				setScope(nextScope);
				if (nextProjectId) setScopeProjectId(nextProjectId);
			}}
		/>
	);

	const markDirty = useCallback(() => {
		syncDirty(true);
	}, [syncDirty]);

	/**
	 * 探测 pi-mcp-adapter 扩展是否已安装（扩展列表）；失败返回 null 由调用方降级。
	 * mcp.json 依赖该扩展被 pi 加载，缺扩展时配置页改为引导安装。
	 */
	const probeAdapter = useCallback(async (): Promise<boolean | null> => {
		try {
			const list = await window.piDesktop.extensions.list();
			return list.extensions.some((ext) => {
				const source = ext.source ?? "";
				const id = ext.id ?? "";
				return id === ADAPTER_EXTENSION_ID || source.includes(ADAPTER_EXTENSION_ID);
			});
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
			const adapterState = await probeAdapter();
			if (generation !== loadGenerationRef.current) return;
			const next = await api.config.getMcp(effectiveProjectId);
			if (generation !== loadGenerationRef.current) return;
			setAdapterInstalled(adapterState);
			setSnapshot(next);
			setWritable(next.writableFile.mcpServers ? next.writableFile : { ...next.writableFile, mcpServers: {} });
			syncDirty(false);
			setCreating(null);
			const names = next.servers.map((item) => item.name);
			setSelected((current) => (current && names.includes(current) ? current : names[0] ?? null));
		} catch (caught) {
			if (generation === loadGenerationRef.current) {
				setError(caught instanceof Error ? caught.message : String(caught));
			}
		} finally {
			if (generation === loadGenerationRef.current) setLoading(false);
		}
	}, [syncDirty, probeAdapter, effectiveProjectId, effectiveScope]);

	useEffect(() => {
		void load();
		return () => {
			// A late response from the previous scope must never replace the current snapshot.
			loadGenerationRef.current += 1;
		};
	}, [load]);

	const displayServers = useMemo(
		() => snapshot ? buildMcpDisplayServers(snapshot, writable, effectiveScope) : [],
		[effectiveScope, snapshot, writable],
	);

	const selectedItem = displayServers.find((item) => item.name === selected) ?? null;
	const editingDef: McpServerDefinition = creating
		? creating.definition
		: (selectedItem?.definition ?? blankDefinition("stdio"));
	const transport = inferMcpTransport(editingDef);

	const applyWritable = useCallback((next: McpConfigFile) => {
		if (effectiveScope === "project") return;
		setWritable(next);
		markDirty();
	}, [markDirty, effectiveScope]);

	const upsert = useCallback((name: string, definition: McpServerDefinition) => {
		applyWritable({
			...writable,
			mcpServers: { ...(writable.mcpServers ?? {}), [name]: definition },
		});
	}, [applyWritable, writable]);

	const startCreate = () => {
		if (effectiveScope === "project") return;
		setCreating({ name: "", definition: blankDefinition("stdio") });
		setSelected(null);
		setProbe(null);
	};

	const cancelCreate = () => {
		setCreating(null);
		setSelected(displayServers[0]?.name ?? null);
		setProbe(null);
		// 新建草稿不在 writable 里；取消后若可写层未改，清掉黄点。
		if (snapshot && JSON.stringify(writable) === JSON.stringify(snapshot.writableFile)) {
			syncDirty(false);
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

	const switchTransport = (next: McpServerTransport) => {
		const kept = {
			lifecycle: editingDef.lifecycle,
			disabled: editingDef.disabled,
			env: editingDef.env,
			headers: editingDef.headers,
		};
		const nextDef = { ...blankDefinition(next), ...kept };
		if (creating) {
			setCreating({ ...creating, definition: nextDef });
			markDirty();
			return;
		}
		if (selected) upsert(selected, nextDef);
	};

	const toggleDisabled = (item: McpServerListItem, disabled: boolean) => {
		const existing = writable.mcpServers?.[item.name];
		if (existing) {
			upsert(item.name, { ...existing, disabled: disabled ? true : undefined });
			return;
		}
		// 下层只读来源：只写 disabled 覆盖，不把 command/url 复制进 Pi 层。
		upsert(item.name, { disabled: disabled ? true : false });
	};

	const removeSelected = () => {
		if (!selected) return;
		const item = selectedItem;
		const nextServers = { ...(writable.mcpServers ?? {}) };
		// 传输定义在 Pi 可写层：真正删除条目。只读层只能写 disabled 覆盖，删覆盖会让服务重新启用。
		if (item?.ownedByWritable) {
			delete nextServers[selected];
			applyWritable({ ...writable, mcpServers: nextServers });
		} else if (item) {
			upsert(selected, { disabled: true });
		}
		const remaining = displayServers.filter((entry) => entry.name !== selected);
		setSelected(remaining[0]?.name ?? null);
		setProbe(null);
	};

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

	const save = useCallback(async (): Promise<boolean> => {
		if (effectiveScope === "project") {
			syncDirty(false);
			return true;
		}
		if (snapshot?.writableError) {
			setError(t("config.mcp.writableBroken"));
			return false;
		}
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
		setSaving(true);
		setError(null);
		try {
			const result = await api.config.saveMcp(toSave);
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			await load();
			if (creating?.name.trim()) setSelected(creating.name.trim());
			return true;
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			return false;
		} finally {
			setSaving(false);
		}
	}, [creating, displayServers, load, syncDirty, effectiveScope, snapshot?.writableError, writable]);

	useImperativeHandle(ref, () => ({ save, reload: load }), [save, load]);

	const layerLabel = useMemo(() => ({
		"user-config": t("config.mcp.layer.userConfig"),
		agents: t("config.mcp.layer.agents"),
		"agents-dir": t("config.mcp.layer.agentsDir"),
		"pi-agent": t("config.mcp.layer.piAgent"),
		project: t("config.mcp.layer.project"),
		"project-pi": t("config.mcp.layer.projectPi"),
	}), []);

	const showAdapterGuide = adapterInstalled === false && effectiveScope === "global";

	if (loading && !snapshot) {
		return <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<strong>{t("config.nav.mcp")}</strong>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.mcp.hint")}</p>
					<p className="mt-1 text-micro text-muted-foreground">{t("config.restartHint")}</p>
					<a
						href={MCP_DOCS}
						className="mt-1 inline-block text-micro text-primary hover:underline"
						onClick={openDocsInSystemBrowser(MCP_DOCS)}
					>
						{t("config.mcp.docs")}
					</a>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{scopeSelector}
					<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
						<RefreshCw size={14} />
						{t("common.refresh")}
					</Button>
					{adapterInstalled !== false && effectiveScope === "global" ? (
						<Button size="sm" onClick={startCreate} disabled={saving || Boolean(creating)}>
							<Plus size={14} />
							{t("config.mcp.add")}
						</Button>
					) : null}
				</div>
			</div>

			{error ? (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">{error}</div>
			) : null}
			{snapshot?.writableError ? (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-control text-danger">
					{t("config.mcp.writableBroken")}
				</div>
			) : null}

			{showAdapterGuide ? (
				<McpAdapterGuide onInstalled={load} />
			) : (
				<>
					<div className="flex flex-wrap gap-1.5">
						{(snapshot?.layers ?? []).map((layer) => (
							<span
								key={layer.kind}
								className={`rounded-sm border px-1.5 py-0.5 font-mono text-micro ${layer.exists ? "border-border-subtle text-text-secondary" : "border-dashed border-border-subtle text-muted-foreground"}`}
								title={layer.path}
							>
								{layerLabel[layer.kind]}
								{effectiveScope === "global" && layer.writable ? ` · ${t("config.mcp.writable")}` : ""}
								{layer.exists ? "" : ` · ${t("config.mcp.missing")}`}
							</span>
						))}
					</div>
					{effectiveScope === "global" && snapshot?.writablePath ? (
						<p className="truncate font-mono text-micro text-muted-foreground" title={snapshot.writablePath}>
							{t("config.mcp.writingTo")}: {snapshot.writablePath}
						</p>
					) : null}
				</>
			)}

			{showAdapterGuide ? null : (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1">
				<McpServerListPane
					scope={effectiveScope}
					projectLayerPaths={(snapshot?.layers ?? [])
						.filter((layer) => layer.kind === "project" || layer.kind === "project-pi")
						.map((layer) => layer.path)}
					servers={displayServers}
					selected={selected}
					creating={Boolean(creating)}
					onSelect={(name) => {
						setSelected(name);
						setProbe(null);
					}}
				/>

				<div className="flex min-h-0 flex-col gap-3 overflow-auto rounded-md border border-border-subtle bg-bg-panel p-3">
					{!selected && !creating ? (
						<div className="py-8 text-center text-micro text-muted-foreground">{t("config.mcp.selectHint")}</div>
					) : (
						<fieldset disabled={effectiveScope === "project"} className="contents">
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.name")}</Label>
								<Input
									value={creating ? creating.name : selected ?? ""}
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
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.transport")}</Label>
								<ConfigSelect
									value={transport}
									options={TRANSPORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
									onChange={(value) => switchTransport(value as McpServerTransport)}
								/>
							</div>
							{transport === "stdio" ? (
								<>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.command")}</Label>
										<Input
											value={editingDef.command ?? ""}
											onChange={(event) => patchEditing({ command: event.target.value, url: undefined, socket: undefined })}
											className="h-8 font-mono"
											placeholder="npx"
										/>
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.args")}</Label>
										<Input
											value={argsToText(editingDef.args)}
											onChange={(event) => patchEditing({ args: textToArgs(event.target.value) })}
											className="h-8 font-mono"
											placeholder="-y chrome-devtools-mcp@1.6.0"
										/>
									</div>
									<div className="grid gap-2">
										<Label>{t("config.mcp.field.cwd")}</Label>
										<Input
											value={editingDef.cwd ?? ""}
											onChange={(event) => patchEditing({ cwd: event.target.value || undefined })}
											className="h-8 font-mono"
										/>
									</div>
								</>
							) : null}
							{transport === "http" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.url")}</Label>
									<Input
										value={editingDef.url ?? ""}
										onChange={(event) => patchEditing({ url: event.target.value, command: undefined, args: undefined, socket: undefined })}
										className="h-8 font-mono"
										placeholder="https://mcp.example.com/mcp"
									/>
								</div>
							) : null}
							{transport === "socket" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.socket")}</Label>
									<Input
										value={editingDef.socket ?? ""}
										onChange={(event) => patchEditing({ socket: event.target.value, command: undefined, url: undefined })}
										className="h-8 font-mono"
									/>
								</div>
							) : null}
							<div className="grid gap-2">
								<Label>{t("config.mcp.field.lifecycle")}</Label>
								<ConfigSelect
									value={editingDef.lifecycle ?? "lazy"}
									options={LIFECYCLE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
									onChange={(value) => patchEditing({ lifecycle: value as McpServerDefinition["lifecycle"] })}
								/>
							</div>
							{transport === "stdio" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.env")}</Label>
									<Textarea
										value={recordToText(editingDef.env)}
										onChange={(event) => patchEditing({ env: textToRecord(event.target.value) })}
										placeholder={t("config.mcp.field.envPlaceholder")}
										className="min-h-20 font-mono text-control"
									/>
								</div>
							) : null}
							{transport === "http" ? (
								<div className="grid gap-2">
									<Label>{t("config.mcp.field.headers")}</Label>
									<Textarea
										value={recordToText(editingDef.headers)}
										onChange={(event) => patchEditing({ headers: textToRecord(event.target.value) })}
										placeholder={t("config.mcp.field.headersPlaceholder")}
										className="min-h-20 font-mono text-control"
									/>
								</div>
							) : null}
							<div className="flex items-center justify-between gap-3 rounded-sm border border-border-subtle px-2.5 py-2">
								<div>
									<div className="text-control font-medium">{t("config.mcp.field.enabled")}</div>
									<div className="text-micro text-muted-foreground">{t("config.mcp.field.enabledHint")}</div>
								</div>
								<Switch
									checked={!isMcpServerDisabled(editingDef)}
									onCheckedChange={(checked) => {
										if (creating) {
											patchEditing({ disabled: checked ? undefined : true });
											return;
										}
										if (selectedItem) toggleDisabled(selectedItem, !checked);
									}}
								/>
							</div>
							{selectedItem && !creating ? (
								<p className="text-micro text-muted-foreground" title={selectedItem.originPath}>
									{t("config.mcp.origin")}: {selectedItem.originPath}
									{selectedItem.ownedByWritable ? "" : ` · ${t("config.mcp.overlayHint")}`}
								</p>
							) : null}
							<div className="flex flex-wrap items-center gap-1.5">
								<Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing || saving}>
									<PlugZap size={14} />
									{probing ? t("config.mcp.probing") : t("config.mcp.probe")}
								</Button>
								{creating ? (
									<Button variant="ghost" size="sm" onClick={cancelCreate}>{t("common.cancel")}</Button>
								) : (
									<Button variant="outline" size="sm" className="text-destructive" onClick={removeSelected} disabled={saving}>
										<Trash2 size={13} />
										{selectedItem?.ownedByWritable ? t("common.delete") : t("config.mcp.disableInstead")}
									</Button>
								)}
							</div>
							{probe ? (
								<div className={`rounded-sm border px-2.5 py-2 text-micro ${probe.ok ? "border-[var(--color-success)]/30 text-[var(--color-success)]" : "border-danger/20 text-danger"}`}>
									{probe.ok ? `${t("config.mcp.probeOk")} · ${probe.detail}` : `${t("config.mcp.probeFail")} · ${probe.error}`}
								</div>
							) : null}
						</fieldset>
					)}
				</div>
			</div>
			)}
		</div>
	);
});
