/**
 * DshProviderCards — DSH 模型 tab 的两类 namespace 卡片（对齐 dsh-web 模型页形态）。
 *
 * - PiAiProvidersCard：llm-pi-ai（动态 providers dict，每个 provider 一行）；
 * - DeepseekRouteCard：llm-deepseek（官方 DeepSeek 路由，单行形态）。
 *

 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Copy, Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import { UsageQueryEntryButton } from "../components/app/UsageQueryEntryButton";
import { ProviderUsageInline } from "../components/app/ProviderUsageInline";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { isDshDeepseekProfileVisibleField, isDshPiAiCustomRoute, isDshPiAiProfileVisibleField } from "./dshFieldLabels";
import { DshSchemaField, type DshNamespaceView } from "./DshSchemaForm";
import { deletePath, dictEntries, normalizeDshSchema, objectFields, pruneEmptyObjects, readDshEntryValue, readPath, setPath, type DshSectionApi } from "./dshSchema";
import { credentialRefFor } from "./dshCredentialRef";
import { DshModelsEditor } from "./DshModelsEditor";
import { validateDshDeepseekModels, type DshDeepseekModelValidationFailure } from "./dshModels";
import type { DshModelRow } from "./DshModelsTable";
import { ProviderMigrationButton } from "./ProviderMigrationButton";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { AddDshProviderDialog } from "./AddDshProviderDialog";
import { buildDshProviderFromDraft, type DshProviderDraft } from "./dshProviderDraft";
import { applyProviderOrder } from "../utils/providerOrder";
import { useProviderReorder } from "../hooks/useProviderReorder";

/** 未提供重排回调时的空实现：保持 hook 调用参数稳定，同时让只读页面照常渲染。 */
const noopReorder = (): void => undefined;

export type DshCredentialState = {
	configured: boolean;
	source?: string;
	writable: boolean;
};

/** 密钥操作回调（由配置页注入：credentials.set/unset + 状态刷新）。 */
export type DshCredentialOps = {
	credentials: Record<string, DshCredentialState>;
	setKey: (ref: string, value: string) => Promise<void>;
	unsetKey: (ref: string) => Promise<void>;
};

/** 收起行头通用布局：[排序手柄] chevron + 模型数 + 状态点 + 右侧操作（折叠时不显示名称/URL/协议）。 */
function ProviderRowHead(props: {
	title?: string;
	subtitle?: string;
	keyRef?: string;
	keyDot?: ReactNode;
	badges?: ReactNode[];
	isOpen: boolean;
	onToggle: () => void;
	onRemove?: () => void;
	removeDisabled?: boolean;
	removeTitle?: string;
	extraActions?: ReactNode;
	/** 行头左侧插槽（供应商排序的拖拽手柄与上移/下移按钮）。 */
	leading?: ReactNode;
}) {
	return (
		// group：上移/下移按钮靠 group-hover 浮现，避免行头常驻一排图标
		<div data-provider-head="" className="group flex items-center gap-2 px-3 py-2">
			{props.leading}
			<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={props.onToggle}>
				{props.isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
				{props.title && <span className="truncate font-mono text-control font-semibold text-foreground">{props.title}</span>}
				{props.subtitle && <span className="truncate text-micro text-muted-foreground">{props.subtitle}</span>}

				{props.badges?.map((badge, index) => (
					<span key={index} className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground">
						{badge}
					</span>
				))}
			</button>
			{props.keyRef && (
				<span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground" title={t("config.dsh.keyEnvRef")}>
					{props.keyRef}
				</span>
			)}
			{props.keyDot}
			{props.extraActions}
			{props.onRemove && (
				<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-danger" title={props.removeTitle} aria-label={props.removeTitle} disabled={props.removeDisabled} onClick={props.onRemove}>
					<Trash2 className="size-3.5" aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}

/** API 密钥状态点：绿=已配置、红=缺失（有名单信息时）、灰=未知/无引用。 */
function KeyStatusDot(props: { state: DshCredentialState | undefined }) {
	const { state } = props;
	if (!state) {
		return <span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" title={t("config.dsh.keyUnknown")} aria-label={t("config.dsh.keyUnknown")} />;
	}
	if (state.configured) {
		return <span className="size-2 shrink-0 rounded-full bg-emerald-500" title={t("config.dsh.keyConfigured")} aria-label={t("config.dsh.keyConfigured")} />;
	}
	return <span className="size-2 shrink-0 rounded-full bg-red-500" title={t("config.dsh.keyMissing")} aria-label={t("config.dsh.keyMissing")} />;
}

/**
 * API 密钥主字段（对齐 dsh-web）：密钥输入不单独保存——草稿上抛到卡片，
 * 由卡片头部的统一保存提交（先 credentials.set 再 settings.update）。
 * 已配置时输入框默认留空；点「眼睛」按 ref 取回明文展示（主进程读凭证文件），
 * 再次点击隐藏并清空；「复制」把明文写入剪贴板。
 */
function ApiKeyField(props: {
	ref: string;
	/** 当前密钥草稿（父级持有；空串 = 未改动）。 */
	value: string;
	onChange: (value: string) => void;
	ops: DshCredentialOps;
}) {
	const { ref, value, onChange, ops } = props;
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);
	const state = ops.credentials[ref];
	const configured = state?.configured === true;
	const writable = state?.writable !== false;

	/** 取回明文（眼睛显示 / 复制共用）：输入框有草稿用草稿，否则读存储值。 */
	const readPlain = async (): Promise<string | undefined> => {
		if (value) return value;
		if (!configured) return undefined;
		return desktopApi.sessions.readDshCredential(ref).catch(() => undefined);
	};

	/** 眼睛切换：显示时取回明文，隐藏时清空输入（明文不常驻渲染层）。 */
	const toggleReveal = async () => {
		if (revealed) {
			setRevealed(false);
			onChange("");
			return;
		}
		if (!value) {
			setBusy(true);
			try {
				const stored = await readPlain();
				if (stored !== undefined) onChange(stored);
			} finally {
				setBusy(false);
			}
		}
		setRevealed(true);
	};

	/** 复制明文到剪贴板（草稿优先，否则读存储值）。 */
	const copyValue = async () => {
		setBusy(true);
		try {
			const plain = await readPlain();
			if (plain !== undefined) {
				await writeClipboard(plain);
				showNotice(t("config.dsh.keyCopied"), 2000);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="grid gap-1.5">
			<span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
				{t("config.dsh.apiKey")}
				<span className="truncate font-mono text-micro text-muted-foreground">{ref}</span>
				{configured && <span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-1.5 py-px text-micro text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">{t("config.dsh.keyConfigured")}</span>}
			</span>
			<div className="flex items-center gap-2">
				<div className="relative max-w-sm flex-1">
					<Input className="h-8 w-full pr-16 font-mono" type={revealed ? "text" : "password"} placeholder={configured ? t("config.dsh.keyStored") : t("config.dsh.keyPlaceholder")} value={value} disabled={!writable || busy} onChange={(event) => onChange(event.target.value)} />
					<div className="absolute inset-y-0 right-0.5 my-auto flex items-center gap-0.5">
						<Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" title={t("config.dsh.keyCopy")} aria-label={t("config.dsh.keyCopy")} disabled={!configured || busy} onClick={() => void copyValue()}>
							<Copy className="size-3.5" aria-hidden="true" />
						</Button>
						<Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" title={revealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")} aria-label={revealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")} disabled={!configured || busy} onClick={() => void toggleReveal()}>
							{revealed ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
						</Button>
					</div>
				</div>
				{configured && (
					<Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-muted-foreground hover:text-danger" disabled={!writable || busy} onClick={() => void ops.unsetKey(ref)}>
						{t("config.dsh.keyUnset")}
					</Button>
				)}
			</div>
			{!state && <p className="text-micro text-muted-foreground">{t("config.dsh.keyRefHint", { ref })}</p>}
			{state && !state.writable && <p className="text-micro text-muted-foreground">{t("config.dsh.keyEnvLocked")}</p>}
		</div>
	);
}

function deepseekModelValidationMessage(failure: DshDeepseekModelValidationFailure): string {
	const index = failure.index + 1;
	switch (failure.issue) {
		case "idRequired":
			return t("config.dsh.modelError.idRequired", { index });
		case "idDuplicate":
			return t("config.dsh.modelError.idDuplicate", { index });
		case "nameInvalid":
			return t("config.dsh.modelError.nameInvalid", { index });
		case "contextInvalid":
			return t("config.dsh.modelError.contextInvalid", { index });
		case "maxTokensInvalid":
			return t("config.dsh.modelError.maxTokensInvalid", { index });
	}
}

/** Only model records are safe to hand to the editable catalog UI. */
function isDshModelRow(value: unknown): value is DshModelRow {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dshModelRows(value: unknown): DshModelRow[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: DshModelRow[] = [];
	for (const item of value) {
		if (!isDshModelRow(item)) return undefined;
		rows.push(item);
	}
	return rows;
}

/** 「自定义设置」折叠区：仅收容 dsh-web 也公开的精选字段。 */
function CustomSettings(props: { label: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-sm border border-border-subtle">
			<button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-caption font-medium text-foreground" onClick={() => setOpen((prev) => !prev)}>
				{open ? <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
				{props.label}
			</button>
			{open && <div className="grid gap-2.5 border-t border-border/40 px-3 py-2.5">{props.children}</div>}
		</div>
	);
}

/**
 * llm-pi-ai providers 卡片：每个 provider 一行（可展开），支持添加/删除 provider。
 * 保存语义与 Pi 管理页一致：不自带保存按钮，草稿变化上报脏状态，
 * 由顶部统一保存；API 密钥在展开区首段独立填写。
 */
export function PiAiProvidersCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	ops: DshCredentialOps;
	/** 适配器内置模型目录（llm.models 按 provider id 分组）；行头模型数与展开区继承模型用它。 */
	catalog?: Record<string, Array<{ id: string; name?: string }>>;
	/** 可配置提供方目录（llm.providers）：添加提供方时从 declared 未激活行选择。 */
	directory?: Array<{ provider: string; displayName: string; active: boolean; declared?: boolean }>;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	/** 统一保存/脏状态接口（ConfigModal 顶部保存 + 关闭确认）。 */
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:<nav>:<sub>）。 */
	instanceKey?: string;
	/** 把供应商迁到 pi 后刷新本页。 */
	onMigrated?: () => void;
	/** 打开用量查询配置弹窗（与 Pi 模型页共用；provider=DSH route 名）。 */
	onOpenUsageProbeDialog: (provider: string) => void;
	/** 供应商卡片自定义顺序（AppSettings.dshProviderOrder，仅展示用）。 */
	providerOrder?: string[];
	/** 排序作用域：DSH 页在「添加 provider」后可能多出未保存的行，父级传入完整集合以保证落点正确。 */
	providerOrderScope?: string[];
	/** 卡片重排回调（父级持久化到 AppSettings）。 */
	onReorderProviders?: (nextOrder: string[]) => void;
	/** 清空自定义顺序（列表上方的「恢复默认顺序」）。 */
	onResetProviders?: () => void;
}) {
	const { namespace, writable, ops, sectionApi } = props;
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];
	const providersField = useMemo(() => {
		if (!schema || !root) return undefined;
		return objectFields(schema, root).find((field) => field.ref.type === "dict");
	}, [schema, root]);

	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [addingProvider, setAddingProvider] = useState(false);
	const [addPageDirty, setAddPageDirty] = useState(false);
	/** 密钥草稿：providerKey → 输入的新密钥（保存时统一 credentials.set）。 */
	const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
	/**
	 * 待删除的 provider 路由（点删除后本地隐藏，保存时才真正删除）。
	 * 必须单独记录：settings.update 是 merge，patch 里删 key 不会让 host 删掉
	 * 现有 provider——删除要走 settings.mutate 的 unset op（merge 语义做不到）。
	 */
	const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
	/** 正在等待确认删除的 provider 路由（null = 无弹窗；确认后才进 pendingRemovals）。 */
	const [removingKey, setRemovingKey] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** 脏状态：settings 草稿、任一密钥草稿或待删除 provider 非空。 */
	const dirty = Object.keys(draft).length > 0 || Object.values(keyDrafts).some((value) => value.trim()) || pendingRemovals.length > 0 || addPageDirty;
	useEffect(() => {
		sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => sectionApi?.onDirtyChange(instanceId, false);
	}, [sectionApi, instanceId, dirty]);

	/** 统一保存：先删待移除 provider（凭证 + 配置，对齐 dsh-web removeProviderProfile），
	 *  再写密钥草稿、提交 settings patch。 */
	const save = useCallback(
		async (addition?: DshProviderDraft): Promise<boolean> => {
			if (!dirty && !addition) return true;
			const added = addition ? buildDshProviderFromDraft(addition) : undefined;
			const saveDraft = added ? { ...draft, providers: { ...(draft.providers && typeof draft.providers === "object" ? draft.providers : {}), [added.name]: added.profile } } : draft;
			const saveKeys = added?.apiKey ? { ...keyDrafts, [added.name]: added.apiKey } : keyDrafts;
			setSaving(true);
			setError(null);
			try {
				// 删除顺序与 dsh-web 一致：先删凭证、再删 provider 配置——第二步失败时
				// provider 行仍可见，整个操作可安全重试（两个 unset 都是幂等的）。
				// 凭证仅当它是「页面管理的派生引用」时联动删除（dsh-web targetOf 语义：
				// apiKeyEnv 恰好等于派生 ref 且已配置且可写）；显式配置的 apiKeyEnv
				// 可能被其他 provider 复用，不删。删除配置走 settings.mutate unset，
				// 因为 settings.update 是 merge，patch 删 key 不会让 host 删掉现有 provider。
				if (pendingRemovals.length > 0) {
					for (const key of pendingRemovals) {
						const currentProfile = (namespace.value as { providers?: Record<string, unknown> } | undefined)?.providers?.[key];
						const meta = (currentProfile ?? {}) as Record<string, unknown>;
						const managedRef = credentialRefFor(undefined, key);
						const explicitRef = typeof meta.apiKeyEnv === "string" && meta.apiKeyEnv.trim() ? meta.apiKeyEnv.trim() : undefined;
						const ref = explicitRef ?? managedRef;
						const state = ops.credentials[ref];
						if (ref === managedRef && state?.configured === true && state.writable) {
							// 静默删凭证（不带 load）：本函数末尾 onSave→saveNamespace 已统一刷新一次，
							// 若走 ops.unsetKey（内部自带 load）会触发第二次全页重渲染（删除保存闪两下）。
							await desktopApi.sessions.unsetDshCredential(ref);
						}
						await desktopApi.sessions.mutateDshSettings(namespace.ns, [{ op: "unset", path: ["providers", key] }], namespace.revision);
					}
				}
				for (const [key, keyValue] of Object.entries(saveKeys)) {
					const trimmed = keyValue.trim();
					if (!trimmed) continue;
					const draftProfile = (saveDraft.providers as Record<string, unknown> | undefined)?.[key];
					const currentProfile = (namespace.value as { providers?: Record<string, unknown> } | undefined)?.providers?.[key];
					const meta = (draftProfile ?? currentProfile) as Record<string, unknown> | undefined;
					const ref = credentialRefFor(meta, key);
					// 同删除路径：静默写凭证，避免与末尾 onSave 的刷新叠加（保存闪两下）。
					await desktopApi.sessions.setDshCredential(ref, trimmed);
				}
				await props.onSave(pruneEmptyObjects(saveDraft) as Record<string, unknown>);
				setDraft({});
				setKeyDrafts({});
				setPendingRemovals([]);
				if (added) {
					setExpanded((previous) => ({ ...previous, [added.name]: true }));
					setAddingProvider(false);
					setAddPageDirty(false);
				}
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				setSaving(false);
			}
		},
		[dirty, keyDrafts, draft, pendingRemovals, namespace.ns, namespace.revision, namespace.value, ops.credentials, props.onSave],
	);
	const addPageSaveRef = useRef<(() => Promise<boolean>) | null>(null);
	const registerAddPageSave = useCallback((save: (() => Promise<boolean>) | null) => {
		addPageSaveRef.current = save;
	}, []);
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		if (!sectionApi) return;
		// 注册项不随草稿/页切换反复删除插入，否则 saveAll 的 Map 迭代会再次保存同一项。
		sectionApi.registerSave(instanceId, () => (addPageSaveRef.current ? addPageSaveRef.current() : saveRef.current()));
		return () => sectionApi.unregisterSave(instanceId);
	}, [sectionApi, instanceId]);

	// 注意：下面的顺序计算 + 排序 hook 必须放在任何提前 return 之前——
	// schema/字段未就绪时组件会早退，若 hook 落在早退之后，schema 异步到达时 hook 数量变化，React 直接报错。
	const providersValue = (namespace.value as { providers?: unknown } | undefined)?.providers;
	// 按 key 深合并：draft 往往只带 models，浅合并会盖掉已保存的 displayName/baseURL
	const mergedProvidersValue = mergeProviderMaps((providersValue ?? {}) as Record<string, unknown>, (draft.providers ?? {}) as Record<string, unknown>);
	const entries = dictEntries(mergedProvidersValue)
		// 待删除的 provider 立即从列表隐藏（host 侧删除在保存时经 mutate unset 提交）
		.filter((entry) => !pendingRemovals.includes(entry.key));
	// 自定义顺序只作用于展示：DSH 配置里的 providers 是 dict，写回是 merge 语义的 patch，无法表达键顺序，
	// 所以排序偏好存在 PiDeck 本地设置（AppSettings.dshProviderOrder），不去改 DSH 配置。
	const orderedEntries = useMemo(() => {
		const byKey = new Map(entries.map((entry) => [entry.key, entry]));
		return applyProviderOrder(
			entries.map((entry) => entry.key),
			props.providerOrder,
		)
			.map((key) => byKey.get(key))
			.filter((entry): entry is (typeof entries)[number] => Boolean(entry));
	}, [entries, props.providerOrder]);
	// 排序输入用有序键列表；DSH 页无隐藏供应商概念，完整列表即可见列表。
	const orderedKeys = useMemo(() => orderedEntries.map((entry) => entry.key), [orderedEntries]);
	const providerReorder = useProviderReorder({ names: props.providerOrderScope?.length ? props.providerOrderScope : orderedKeys, visibleNames: orderedKeys, onReorder: props.onReorderProviders ?? noopReorder });

	if (!schema || !root || !providersField) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const innerRefId = providersField.ref.inner;
	if (innerRefId === undefined) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}
	const inner = schema.refs[innerRefId];

	/** 草稿覆盖读取：draft 优先，否则用现值（缺失草稿路径必须回退，不能吞已保存值）。 */
	const entryValue = (key: string, path: string[]) => readDshEntryValue(draft, namespace.value, key, path);

	const updateEntry = (key: string, path: string[], next: unknown) => {
		const nextDraft = structuredClone(draft) as Record<string, unknown>;
		const draftPath = ["providers", key, ...path];
		let current: Record<string, unknown> = nextDraft;
		for (let index = 0; index < draftPath.length - 1; index += 1) {
			const segment = draftPath[index];
			const existing = current[segment];
			if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
				current[segment] = {};
			}
			current = current[segment] as Record<string, unknown>;
		}
		const last = draftPath[draftPath.length - 1];
		if (next === undefined || next === "") {
			delete current[last];
		} else {
			current[last] = next;
		}
		setDraft(nextDraft);
	};

	/** 点删除：先弹确认（与 Pi 管理页同款 ConfirmDialog，danger 样式）。 */
	const removeProvider = (key: string) => {
		setRemovingKey(key);
	};

	/** 确认删除：本地立即隐藏 + 记录待删除；host 侧删除在保存时经 settings.mutate
	 *  unset 提交（merge patch 删 key 无效——host 只合并 patch 里出现的字段）。 */
	const confirmRemoveProvider = () => {
		const key = removingKey;
		if (!key) return;
		setRemovingKey(null);
		setPendingRemovals((prev) => (prev.includes(key) ? prev : [...prev, key]));
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			delete providers[key];
			next.providers = providers;
			return next;
		});
		setExpanded((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
		setKeyDrafts((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	};

	/** 整表写入自定义 models：编辑器已按目录/已保存列表铺底，这里不再从空 draft 起步。 */
	const setProviderModels = (providerKey: string, models: DshModelRow[]) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const provider = (providers[providerKey] ?? {}) as Record<string, unknown>;
			provider.models = models;
			providers[providerKey] = provider;
			next.providers = providers;
			return next;
		});
	};

	// API 密钥在「自定义设置」折叠区内填写；profile 默认值/高级字段隐藏——
	// 折叠区只露 dsh-web pi-ai 家族白名单（baseURL / baseUrl / api / displayName），其余归源文件。
	const providerProfileFields = objectFields(schema, inner).filter((field) => isDshPiAiProfileVisibleField(field.name));

	// 展开区直接平铺的固定顺序：显示名称 → Base URL → 结果协议，其余白名单字段随后。
	// 不依赖折叠、不依赖 objectFields 顺序：打开卡片即显示具体字段的值。
	const PROFILE_FIELD_ORDER = ["displayName", "baseURL", "baseUrl", "api"] as const;
	const orderedProfileFields = [...PROFILE_FIELD_ORDER.map((name) => providerProfileFields.find((field) => field.name === name)).filter((field): field is NonNullable<typeof field> => Boolean(field)), ...providerProfileFields.filter((field) => !(PROFILE_FIELD_ORDER as readonly string[]).includes(field.name))];

	if (addingProvider) {
		return <AddDshProviderDialog existingNames={orderedKeys} directory={props.directory} settingsNs={namespace.ns} writable={writable} onRegisterSave={registerAddPageSave} onDirtyChange={setAddPageDirty} onConfirm={save} error={error} onBack={() => setAddingProvider(false)} />;
	}

	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
				<span className="text-caption font-semibold text-foreground">{namespace.ns}</span>
				<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">{t("config.dsh.providersCount", { count: orderedEntries.length })}</span>
				{error && (
					<span className="max-w-64 truncate text-micro text-danger" title={error}>
						{error}
					</span>
				)}
				{dirty && (
					<span className="ml-auto text-micro text-amber-500" title={t("config.dirtyTooltip")}>
						●
					</span>
				)}
				{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>

			<div className="grid gap-2 p-4">
				<Button type="button" variant="secondary" size="sm" className="h-7 justify-self-start" disabled={!writable} onClick={() => setAddingProvider(true)}>
					<Plus className="size-3.5" aria-hidden="true" />
					{t("config.dsh.addProvider")}
				</Button>

				{/* 排序说明：顺序是 PiDeck 本地偏好（AppSettings.dshProviderOrder），不写回 DSH 配置文件 */}
				{orderedKeys.length > 1 && (
					<div className="mt-2 mb-2.5 flex items-start gap-2 text-[11px] leading-relaxed text-text-tertiary">
						<ArrowUpDown className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
						<span className="min-w-0 flex-1">{t("config.dsh.providerOrderHint")}</span>
						{(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders && (
							<Button type="button" variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-[11px] font-normal text-text-tertiary hover:text-text-primary" onClick={props.onResetProviders}>
								{t("config.providerOrderReset")}
							</Button>
						)}
					</div>
				)}

				{/* provider 行列表 */}
				{orderedEntries.map((entry) => {
					const isOpen = expanded[entry.key] ?? false;
					// 模型列表：draft 覆盖优先（新增/删除行即时反映），否则用现值
					const draftModels = entryValue(entry.key, ["models"]);
					// 已保存列表必须读 namespace，不能读 entry.value：后者可能是未合并的 draft 碎片
					const persisted = (namespace.value as { providers?: Record<string, { models?: unknown }> } | undefined)?.providers?.[entry.key]?.models;
					const savedModels = Array.isArray(persisted) ? (persisted as DshModelRow[]) : [];
					const models = Array.isArray(draftModels) ? (draftModels as DshModelRow[]) : savedModels;
					const providerMeta = (entry.value ?? {}) as Record<string, unknown>;
					const directoryEntry = props.directory?.find((candidate) => candidate.provider === entry.key);
					// `declared` means pi-ai knows this key only because settings named it.
					// Catalog routes own their display name/protocol; an absent directory entry
					// is treated as custom so a new route remains completable before refresh.
					const isCustomRoute = isDshPiAiCustomRoute(directoryEntry);
					const visibleProfileFields = isCustomRoute ? orderedProfileFields : orderedProfileFields.filter((field) => field.name === "baseURL" || field.name === "baseUrl");
					const baseURLValue = entryValue(entry.key, ["baseURL"]);
					const apiValue = entryValue(entry.key, ["api"]);
					const baseURL = typeof baseURLValue === "string" ? baseURLValue : "";
					const api = typeof apiValue === "string" ? apiValue : "";
					const keyRef = credentialRefFor(providerMeta, entry.key);
					const providerCatalog = props.catalog?.[entry.key];
					// 生效模型数：自定义 models 非空取自定义数，否则取内置目录数（dsh-web 同语义）
					const modelCount = models.length > 0 ? models.length : (providerCatalog?.length ?? 0);
					return (
						<div key={entry.key} ref={(element) => providerReorder.registerCard(entry.key, element)} className={`relative rounded-md border border-border-subtle bg-bg-panel${providerReorder.draggingName === entry.key ? " opacity-50" : ""}`} {...providerReorder.cardProps(entry.key)}>
							{/* 拖拽插入指示线：贴卡片内缘 */}
							{providerReorder.dropTarget?.name === entry.key && <span className={`absolute ${providerReorder.dropTarget.position === "before" ? "top-0" : "bottom-0"} right-0 left-0 z-10 h-0.5 bg-[color:var(--color-accent)]`} />}
							<ProviderRowHead
								leading={
									<>
										{/* 拖拽手柄：只有按住手柄才能拖动，避免与行内点击折叠抢手势；上移/下移悬停浮现，键盘聚焦也可见 */}
										<Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" title={t("config.dragProvider")} {...providerReorder.gripProps(entry.key)}>
											<GripVertical className="size-3.5" aria-hidden="true" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
											disabled={!providerReorder.canMove(entry.key, -1)}
											title={t("config.moveProviderUp")}
											onClick={() => providerReorder.moveBy(entry.key, -1)}
										>
											<ArrowUp className="size-3" aria-hidden="true" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
											disabled={!providerReorder.canMove(entry.key, 1)}
											title={t("config.moveProviderDown")}
											onClick={() => providerReorder.moveBy(entry.key, 1)}
										>
											<ArrowDown className="size-3" aria-hidden="true" />
										</Button>
									</>
								}
								title={entry.key}
								badges={[t("config.dsh.modelsCount", { count: modelCount })]}
								keyDot={<KeyStatusDot state={ops.credentials[keyRef]} />}
								extraActions={
									<>
										{/* 用量徽章常驻（DSH 链路 backend=dsh）：与模型/认证页同款，开关即「是否启用用量查询」 */}
										<span className="shrink-0" onClick={(event) => event.stopPropagation()}>
											<ProviderUsageInline provider={entry.key} variant="card" backend="dsh" />
										</span>
										{/* 用量查询配置（内置支持的供应商零配置自动生效，不渲染；DSH 链路 backend=dsh） */}
										<UsageQueryEntryButton provider={entry.key} backend="dsh" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" onOpen={() => props.onOpenUsageProbeDialog(entry.key)} />
										<ProviderMigrationButton direction="dsh-to-pi" provider={entry.key} onMigrated={props.onMigrated} />
									</>
								}
								isOpen={isOpen}
								onToggle={() => setExpanded((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
								onRemove={() => removeProvider(entry.key)}
								removeDisabled={!writable}
								removeTitle={t("config.dsh.removeProvider")}
							/>

							{isOpen && (
								<div className="grid gap-3 border-t border-border/40 px-3 py-3">
									<ApiKeyField ref={keyRef} value={keyDrafts[entry.key] ?? ""} onChange={(next) => setKeyDrafts((prev) => ({ ...prev, [entry.key]: next }))} ops={ops} />
									<CustomSettings label={t("config.dsh.customSettings")}>
										<p className="text-micro text-muted-foreground">{t("config.dsh.customSettingsHint")}</p>
										{/* A catalog route owns its display name/protocol; hand-declared routes own both. */}
										{visibleProfileFields.map((field) => (
											<DshSchemaField key={field.name} schema={schema} ref={field.ref} path={[field.name]} value={entryValue(entry.key, [field.name])} secrets={namespace.secrets} onChange={(path, next) => updateEntry(entry.key, path, next)} writable={writable} />
										))}
									</CustomSettings>
									<DshModelsEditor models={models} savedModels={savedModels} catalog={providerCatalog} writable={writable} providerKey={entry.key} settingsNs={namespace.ns} baseURL={baseURL} api={api} apiKeyDraft={keyDrafts[entry.key]} onChange={(nextModels) => setProviderModels(entry.key, nextModels)} />
								</div>
							)}
						</div>
					);
				})}
				{orderedEntries.length === 0 && <Empty text={t("config.dsh.providersEmpty")} />}
			</div>
			{removingKey && <ConfirmDialog title={t("common.deleteConfirm")} message={t("common.deleteConfirmMsg", { name: removingKey })} confirmLabel={t("common.delete")} danger onConfirm={confirmRemoveProvider} onCancel={() => setRemovingKey(null)} />}
		</div>
	);
}

/**
 * llm-deepseek 官方路由卡片：单行形态（无动态 providers dict）。
 * 收起一行 = 路由名 + 密钥状态点 + 模型数；展开 = 自定义设置 + 模型列表。
 */
export function DeepseekRouteCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	ops: DshCredentialOps;
	/** 适配器内置模型目录（llm.models 中 provider=deepseek-official 的分组）。 */
	catalog?: Array<{ id: string; name?: string }>;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	/** Reload parent namespace state after a mutate-only operation (such as model reset). */
	onRefresh?: () => Promise<unknown>;
	/** 统一保存/脏状态接口（ConfigModal 顶部保存 + 关闭确认）。 */
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:<nav>:<sub>）。 */
	instanceKey?: string;
	/** 把官方 DeepSeek 迁到 pi 后刷新本页。 */
	onMigrated?: () => void;
	/** 打开用量查询配置弹窗（与 Pi 模型页共用；provider=DSH route 名）。 */
	onOpenUsageProbeDialog: (provider: string) => void;
}) {
	const { namespace, writable, ops, sectionApi } = props;
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];

	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [open, setOpen] = useState(false);
	/** 密钥草稿：保存时单独写入 credentials，不落 settings.yaml。 */
	const [keyDraft, setKeyDraft] = useState("");
	/** `models: []` has a different direct-DeepSeek meaning, so reset must mutate-unset it. */
	const [pendingModelReset, setPendingModelReset] = useState(false);
	/** Curated profile fields reset to adapter defaults through explicit path unsets. */
	const [pendingFieldUnsets, setPendingFieldUnsets] = useState<string[][]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Effective value is needed for adapter-owned defaults such as apiKeyEnv. */
	const value = (path: string[]) => {
		const overridden = readPath(draft, path);
		return overridden !== undefined ? overridden : readPath(namespace.value, path);
	};
	/** Curated editable fields should show only a user override, not composition defaults. */
	const editableValue = (path: string[]) => {
		if (pendingFieldUnsets.some((candidate) => candidate.join("\u0000") === path.join("\u0000"))) return undefined;
		const overridden = readPath(draft, path);
		return overridden !== undefined ? overridden : readPath(namespace.user, path);
	};

	// 密钥 ref 需在保存回调之前计算（save useCallback 依赖它）
	const apiKeyEnv = typeof value(["apiKeyEnv"]) === "string" ? (value(["apiKeyEnv"]) as string) : "";
	const keyRef = credentialRefFor({ apiKeyEnv }, "deepseek");

	/** 脏状态：settings 草稿、密钥草稿或待提交的模型/字段 reset。 */
	const dirty = Object.keys(draft).length > 0 || keyDraft.trim().length > 0 || pendingModelReset || pendingFieldUnsets.length > 0;
	useEffect(() => {
		sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => sectionApi?.onDirtyChange(instanceId, false);
	}, [sectionApi, instanceId, dirty]);

	/**
	 * Persist the visible profile fields and the credential through their separate
	 * DSH APIs. Reset is a mutate/unset because settings.update only merges and
	 * `models: []` would mean an intentionally empty official catalog.
	 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		setError(null);
		try {
			const modelFailure = validateDshDeepseekModels(readPath(draft, ["models"]));
			if (modelFailure) {
				setError(deepseekModelValidationMessage(modelFailure));
				return false;
			}
			const patch = pruneEmptyObjects(draft) as Record<string, unknown>;
			const unsetOps = [...(pendingModelReset ? [{ op: "unset" as const, path: ["models"] }] : []), ...pendingFieldUnsets.map((path) => ({ op: "unset" as const, path }))];
			if (unsetOps.length > 0) {
				await desktopApi.sessions.mutateDshSettings(namespace.ns, unsetOps, namespace.revision);
			}
			if (Object.keys(patch).length > 0) {
				await props.onSave(patch);
			} else if (unsetOps.length > 0) {
				if (props.onRefresh) await props.onRefresh();
				else await props.onSave({});
			}
			const trimmed = keyDraft.trim();
			if (trimmed) await ops.setKey(keyRef, trimmed);
			setDraft({});
			setKeyDraft("");
			setPendingModelReset(false);
			setPendingFieldUnsets([]);
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, draft, keyDraft, keyRef, namespace.ns, namespace.revision, ops, pendingFieldUnsets, pendingModelReset, props]);
	useEffect(() => {
		if (!sectionApi) return;
		sectionApi.registerSave(instanceId, save);
		return () => sectionApi.unregisterSave(instanceId);
	}, [sectionApi, instanceId, save]);

	if (!schema || !root) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const update = (path: string[], next: unknown) => {
		const nextDraft = structuredClone(draft) as Record<string, unknown>;
		if (next === undefined || next === "") {
			deletePath(nextDraft, path);
			const hasUserValue = readPath(namespace.user, path) !== undefined;
			setPendingFieldUnsets((previous) => {
				const alreadyPending = previous.some((candidate) => candidate.join("\u0000") === path.join("\u0000"));
				if (hasUserValue) return alreadyPending ? previous : [...previous, path];
				return alreadyPending ? previous.filter((candidate) => candidate.join("\u0000") !== path.join("\u0000")) : previous;
			});
		} else {
			setPath(nextDraft, path, next);
			setPendingFieldUnsets((previous) => previous.filter((candidate) => candidate.join("\u0000") !== path.join("\u0000")));
		}
		setDraft(nextDraft);
	};

	// DSH Web builds inherited rows from composition `base` first and then the
	// schema default. `value` is only a legacy fallback because it may still
	// carry the user override that reset is about to remove.
	const draftModels = dshModelRows(readPath(draft, ["models"]));
	const userModels = dshModelRows(readPath(namespace.user, ["models"]));
	const baseModels = dshModelRows(readPath(namespace.base, ["models"]));
	const schemaDefaultModels = dshModelRows(objectFields(schema, root).find((field) => field.name === "models")?.ref.meta?.default);
	const effectiveModels = dshModelRows(readPath(namespace.value, ["models"]));
	const inheritedModels = baseModels ?? schemaDefaultModels ?? (userModels === undefined ? effectiveModels : undefined) ?? dshModelRows(props.catalog) ?? [];
	const modelOverride = !pendingModelReset && (draftModels !== undefined || userModels !== undefined);
	const models = draftModels ?? (modelOverride ? (effectiveModels ?? userModels ?? []) : inheritedModels);
	const savedModels = models;
	const directCatalog = inheritedModels;
	const baseURLValue = value(["baseURL"]);
	const apiValue = value(["api"]);
	const baseURL = typeof baseURLValue === "string" ? baseURLValue : "";
	const api = typeof apiValue === "string" ? apiValue : "";
	const defaultContextWindowValue = value(["defaultContextWindow"]);
	const defaultMaxTokensValue = value(["maxTokens"]);
	const defaultContextWindow = typeof defaultContextWindowValue === "number" ? defaultContextWindowValue : undefined;
	const defaultMaxTokens = typeof defaultMaxTokensValue === "number" ? defaultMaxTokensValue : undefined;
	const baseFields = objectFields(schema, root).filter((field) => isDshDeepseekProfileVisibleField(field.name));

	const setModels = (nextModels: DshModelRow[]) => {
		setPendingModelReset(false);
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			next.models = nextModels;
			return next;
		});
	};

	const resetModels = () => {
		setPendingModelReset(true);
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			delete next.models;
			return next;
		});
	};

	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
				<span className="text-caption font-semibold text-foreground">{namespace.ns}</span>
				<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">{namespace.applies === "live" ? t("config.dsh.appliesLive") : t("config.dsh.appliesRestart")}</span>
				{error && (
					<span className="max-w-64 truncate text-micro text-danger" title={error}>
						{error}
					</span>
				)}
				{dirty && (
					<span className="ml-auto text-micro text-amber-500" title={t("config.dirtyTooltip")}>
						●
					</span>
				)}
				{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>
			<div className="grid gap-2 p-4">
				<div className="rounded-md border border-border-subtle bg-bg-panel">
					<ProviderRowHead
						title={namespace.ns === "llm-deepseek" ? t("config.dsh.deepseekOfficial") : namespace.ns}
						badges={[t("config.dsh.modelsCount", { count: modelOverride ? models.length : directCatalog.length })]}
						keyDot={<KeyStatusDot state={ops.credentials[keyRef]} />}
						extraActions={
							<>
								{/* 用量徽章常驻（DSH 官方 DeepSeek）：provider 名归一为 deepseek，与卡片/选择器同缓存 key */}
								<span className="shrink-0" onClick={(event) => event.stopPropagation()}>
									<ProviderUsageInline provider="deepseek" variant="card" backend="dsh" />
								</span>
								{/* 用量查询配置（内置支持的供应商零配置自动生效，不渲染；DSH 官方 DeepSeek） */}
								<UsageQueryEntryButton provider="deepseek" backend="dsh" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" onOpen={() => props.onOpenUsageProbeDialog("deepseek")} />
								<ProviderMigrationButton direction="dsh-to-pi" provider="deepseek" onMigrated={props.onMigrated} />
							</>
						}
						isOpen={open}
						onToggle={() => setOpen((prev) => !prev)}
					/>

					{open && (
						<div className="grid gap-3 border-t border-border/40 px-3 py-3">
							<ApiKeyField ref={keyRef} value={keyDraft} onChange={setKeyDraft} ops={ops} />
							<CustomSettings label={t("config.dsh.customSettings")}>
								<p className="text-micro text-muted-foreground">{t("config.dsh.customSettingsHint")}</p>
								{baseFields.map((field) => (
									<DshSchemaField key={field.name} schema={schema} ref={field.ref} path={[field.name]} value={editableValue([field.name])} placeholder={t("config.dsh.deepseekBaseUrlPlaceholder")} secrets={namespace.secrets} onChange={update} writable={writable} />
								))}
							</CustomSettings>
							<DshModelsEditor
								models={models}
								savedModels={savedModels}
								catalog={directCatalog}
								writable={writable}
								providerKey="deepseek-official"
								settingsNs={namespace.ns}
								baseURL={baseURL}
								api={api}
								apiKeyDraft={keyDraft}
								modelsOverridden={modelOverride}
								onResetModels={modelOverride ? resetModels : undefined}
								editableInherited
								defaultContextWindow={defaultContextWindow}
								defaultMaxTokens={defaultMaxTokens}
								onChange={setModels}
							/>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** 现值与草稿按 provider key 合并；同一 key 下对象字段再浅合并一层。 */
function mergeProviderMaps(saved: Record<string, unknown>, draft: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...saved };
	for (const [key, draftEntry] of Object.entries(draft)) {
		const savedEntry = saved[key];
		if (savedEntry && typeof savedEntry === "object" && !Array.isArray(savedEntry) && draftEntry && typeof draftEntry === "object" && !Array.isArray(draftEntry)) {
			next[key] = { ...(savedEntry as Record<string, unknown>), ...(draftEntry as Record<string, unknown>) };
		} else {
			next[key] = draftEntry;
		}
	}
	return next;
}

function Empty(props: { text: string }) {
	return <div className="rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-8 text-center text-control text-muted-foreground">{props.text}</div>;
}
