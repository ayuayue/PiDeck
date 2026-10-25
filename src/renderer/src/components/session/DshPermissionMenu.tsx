/**
 * DSH 会话权限预设选择器（输入框底栏安全位）
 *
 * DSH 后端不适用 PiDeck 内置安全等级（SecurityStore/安全门是 pi 链路的产物），
 * 走 DSH 自己的权限预设：read-only / workspace-write / danger-full-access
 * （sandbox 模式 + approval 策略的捆绑，与 dsh-web 的 PermissionSelect 同一组值）。
 *
 * 交互与 pi 侧 SecurityLevelMenu 同族（#214 统一）：shadcn DropdownMenu 轻量
 * 下拉（紧贴触发按钮的小列表）；三档固定选项不需要搜索/折叠，居中 CommandPicker
 * 弹窗在该场景过重。图标走 utils/permissionLevelIcon 的统一保护强度语义
 * （read-only=ShieldAlert 最严 / workspace-write=ShieldCheck / full-access=ShieldOff），
 * 触发按钮与 pi 一致为纯图标（当前档位见 title 工具提示）。
 *
 * - 读取：当前预设来自 host 会话事件折叠（permission/preset，经 runtime-state
 *   推送）；未启动/草稿会话回退到 settings permission.defaultPreset（新会话默认）。
 * - 切换：host 侧 slash 桥在 agent/pre-step 拦截 `/permission <name>` 并执行
 *   （命令事件 permission/preset + sandbox/mode + approval/policy 落会话日志，
 *   消息不进模型、不上时间线），随后 runtime-state 推送刷新底栏。
 * - danger-full-access 需确认（与 dsh-web 一致：完全访问是高风险预设）。
 */
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { sessionRecordByIdAtomFamily, sessionRuntimeByIdAtom, sessionRuntimeBySessionIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { ConfirmDialog } from "../app/AppParts";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { permissionStrengthIcon } from "../../utils/permissionLevelIcon";
import { requireSessionCommand, toSessionRuntimeTarget } from "../../utils/sessionCommands";

/** DSH 权限预设（与 host 预设表一致；顺序即展示顺序）。 */
export const DSH_PERMISSION_PRESETS = [
	{ id: "read-only", labelKey: "dshPermission.readOnly", descriptionKey: "dshPermission.readOnlyDesc", strength: "strict" },
	{ id: "workspace-write", labelKey: "dshPermission.workspaceWrite", descriptionKey: "dshPermission.workspaceWriteDesc", strength: "standard" },
	{ id: "danger-full-access", labelKey: "dshPermission.fullAccess", descriptionKey: "dshPermission.fullAccessDesc", strength: "relaxed" },
] as const;

const FULL_ACCESS = "danger-full-access";

/** 预设图标按统一保护强度语义取（未知/自定义预设用通用盾牌） */
function presetIcon(preset: string | undefined) {
	const known = DSH_PERMISSION_PRESETS.find((item) => item.id === preset);
	return permissionStrengthIcon(known?.strength ?? "unknown");
}

function presetLabel(preset: string | undefined): string {
	if (!preset) return t("dshPermission.unknown");
	const known = DSH_PERMISSION_PRESETS.find((item) => item.id === preset);
	return known ? t(known.labelKey) : t("dshPermission.custom");
}

export function DshPermissionMenu(props: { sessionId: string; disabled?: boolean }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const upsertSession = useSetAtom(upsertSessionAtom);
	const store = useStore();
	const [open, setOpen] = useState(false);
	const [confirmingFull, setConfirmingFull] = useState(false);
	const [sending, setSending] = useState(false);
	const [defaultPreset, setDefaultPreset] = useState<string | undefined>(undefined);

	// 当前生效预设：运行时折叠值（激活会话）> 会话记录预选（草稿期）> settings 默认
	const effectivePreset = runtime?.state?.permissionPreset ?? record?.permissionPreset ?? defaultPreset;

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions
			.describeDshSettings()
			.then((result) => {
				if (cancelled) return;
				const permission = result.namespaces.find((ns) => ns.ns === "permission");
				const value = permission?.value as { defaultPreset?: unknown } | undefined;
				if (value && typeof value.defaultPreset === "string") {
					setDefaultPreset(value.defaultPreset);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const hasRuntime = Boolean(runtime?.agentId);

	/** 切换：激活会话发 /permission <name>（host slash 桥执行，不进模型/不上时间线）；
	 *  草稿会话只写记录预选，激活时 applyPreferences 应用。两者都回写记录（源真相）。 */
	const switchPreset = async (preset: string) => {
		if (!hasRuntime) {
			// 引导页虚拟会话（无 catalog record）：没有可写的会话记录，直接提示
			// 而不是走 IPC——updateRecord("renderer:guide-bootstrap") 必然报
			// 「会话不存在」。会话创建（首次发送）后权限预设回落 settings 默认。
			if (!record) {
				showNotice(t("dshPermission.presetNeedsSession"), 4000);
				setOpen(false);
				return;
			}
			// 草稿期预选：启动会话后生效
			try {
				const updated = await desktopApi.sessions.updateRecord(props.sessionId, { permissionPreset: preset });
				upsertSession(updated);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
				return;
			}
			showNotice(t("dshPermission.presetPendingNotice", { name: presetLabel(preset) }), 3000);
			setOpen(false);
			return;
		}
		setSending(true);
		try {
			const target = toSessionRuntimeTarget(props.sessionId, runtime);
			if (!target) {
				throw new Error(t("sessionCommand.runtimeUnavailable"));
			}
			// 权限是 runtime 控制命令，不是聊天 prompt：专用 IPC 会校验 runtime
			// generation，并等待 DSH 的 permission/preset 事件确认真正生效。
			const result = requireSessionCommand(await desktopApi.sessions.setRuntimePermission(target, preset));
			// Targeted commands wrap the state in { target, value }; only merge the
			// returned AgentRuntimeState into the session-scoped atom.
			const agentState = result.value;
			if (agentState.permissionPreset !== preset) {
				throw new Error(t("dshPermission.switchFailed"));
			}
			const current = store.get(sessionRuntimeByIdAtom)[props.sessionId];
			if (current) {
				store.set(sessionRuntimeByIdAtom, {
					...store.get(sessionRuntimeByIdAtom),
					[props.sessionId]: {
						...current,
						state: current.state ? { ...current.state, ...agentState } : agentState,
					},
				});
			}
			// 协调器已在 host 确认后写 catalog；这里同步 renderer catalog，避免按钮
			// 在事件推送到达前短暂显示旧预设。
			const updated = await desktopApi.sessions.updateRecord(props.sessionId, { permissionPreset: preset });
			upsertSession(updated);
			showNotice(t("dshPermission.switchNotice", { name: presetLabel(preset) }), 3000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSending(false);
			setOpen(false);
		}
	};

	const pick = (preset: string) => {
		if (preset === FULL_ACCESS) {
			setOpen(false);
			setConfirmingFull(true);
			return;
		}
		void switchPreset(preset);
	};

	const Icon = presetIcon(effectivePreset);

	return (
		<>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="composer-bar-btn security dsh size-7 rounded-md text-foreground hover:bg-muted/60" disabled={props.disabled || sending} aria-label={t("dshPermission.menuTitle")} title={`${t("dshPermission.menuTitle")}: ${presetLabel(effectivePreset)}`}>
						<Icon size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" sideOffset={4} className="dsh-permission-menu min-w-72">
					{/* 顶部状态提示行：与 pi 安全等级菜单同款 */}
					<div className="border-b border-border/60 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">{t("dshPermission.menuHint")}</div>
					{DSH_PERMISSION_PRESETS.map((preset) => {
						const selected = effectivePreset === preset.id;
						const ItemIcon = presetIcon(preset.id);
						return (
							<DropdownMenuItem key={preset.id} data-picker-value={preset.id} disabled={sending} onSelect={() => pick(preset.id)} title={t(preset.descriptionKey)} className="min-h-9 gap-2 px-2.5 py-1">
								<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
									<ItemIcon size={14} strokeWidth={2} aria-hidden="true" />
								</span>
								<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{t(preset.labelKey)}</span>
								{selected ? <Check size={14} strokeWidth={2} className="shrink-0 text-primary" aria-hidden="true" /> : null}
							</DropdownMenuItem>
						);
					})}
					{effectivePreset &&
						!DSH_PERMISSION_PRESETS.some((item) => item.id === effectivePreset) &&
						(() => {
							const CustomIcon = presetIcon(effectivePreset);
							return (
								<DropdownMenuItem data-picker-value="custom" disabled className="min-h-9 gap-2 px-2.5 py-1 opacity-60">
									<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
										<CustomIcon size={14} strokeWidth={2} aria-hidden="true" />
									</span>
									<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{t("dshPermission.custom")}</span>
								</DropdownMenuItem>
							);
						})()}
				</DropdownMenuContent>
			</DropdownMenu>
			{confirmingFull && (
				<ConfirmDialog
					title={t("dshPermission.fullAccessConfirmTitle")}
					message={t("dshPermission.fullAccessConfirmBody")}
					confirmLabel={t("dshPermission.fullAccessConfirmLabel")}
					// 完全访问是高风险预设，确认按钮用 destructive 配色（与删除/清空同级视觉信号）
					danger
					onConfirm={() => {
						setConfirmingFull(false);
						void switchPreset(FULL_ACCESS);
					}}
					onCancel={() => setConfirmingFull(false)}
				/>
			)}
		</>
	);
}
