/**
 * 会话安全等级选择器（输入框底栏）
 *
 * 每个会话可独立选择安全等级：会话级覆盖（sessionId → levelId）保存在
 * SecurityStore，选择后主进程写策略快照，安全门扩展热更新（≤2s）即时生效。
 *
 * 交互形态：shadcn DropdownMenu 轻量下拉（紧贴触发按钮的小列表，与底栏后端
 * 选择器/「+」菜单同族）。安全等级是三档固定选项，不需要搜索/折叠/分组——
 * 居中 CommandPicker 弹窗在该场景是过重的交互，下拉更贴合输入栏位；等级描述
 * 以行内工具提示承载。自包含组件，按 sessionId 隔离订阅，不依赖全局 atom。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import type { SecurityConfig, SecurityLevelConfig } from "../../../../shared/types";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { t } from "../../i18n";
import { permissionStrengthIcon } from "../../utils/permissionLevelIcon";

const api = (
	window as unknown as {
		piDesktop: {
			security: {
				getConfig: () => Promise<SecurityConfig>;
				setSessionLevel: (sessionId: string, levelId: string | null) => Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>;
			};
		};
	}
).piDesktop;

/** 等级图标：按统一保护强度语义取（utils/permissionLevelIcon，#214 与 DSH 权限预设同源） */
function levelIcon(level: SecurityLevelConfig) {
	if (level.id === "off") return permissionStrengthIcon("relaxed");
	if (level.id === "strict") return permissionStrengthIcon("strict");
	if (level.id === "standard") return permissionStrengthIcon("standard");
	return permissionStrengthIcon("unknown");
}

export function SecurityLevelMenu(props: { sessionId: string; disabled?: boolean }) {
	const [config, setConfig] = useState<SecurityConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		api.security
			.getConfig()
			.then((loaded) => {
				if (mountedRef.current) setConfig(loaded);
			})
			.catch(() => {
				// 配置拉取失败：菜单置灰即可，不打扰输入
			});
		return () => {
			mountedRef.current = false;
		};
	}, [props.sessionId]);

	// 当前生效等级 id：会话覆盖优先，其次全局默认
	const effectiveLevelId = useMemo(() => {
		if (!config) return null;
		return config.sessionOverrides[props.sessionId] ?? config.defaultLevelId;
	}, [config, props.sessionId]);

	const effectiveLevel = useMemo(() => {
		if (!config || !effectiveLevelId) return null;
		return config.levels.find((level) => level.id === effectiveLevelId) ?? null;
	}, [config, effectiveLevelId]);

	const handlePick = useCallback(
		async (levelId: string | null) => {
			setSaving(true);
			try {
				const result = await api.security.setSessionLevel(props.sessionId, levelId);
				if (result.ok && mountedRef.current) {
					setConfig(result.config);
				}
			} catch {
				// 保存失败保持原状
			} finally {
				if (mountedRef.current) setSaving(false);
			}
		},
		[props.sessionId],
	);

	if (!config) {
		// 配置未加载完成时不渲染（避免闪烁/误点）
		return null;
	}

	const enabled = config.enabled;
	const levelName = effectiveLevel?.name ?? t("security.levelUnknown");
	const hasSessionOverride = effectiveLevelId != null && effectiveLevelId !== config.defaultLevelId;

	// 触发器图标反映当前安全状态：停用显示关闭盾，启用时按等级换专属盾
	const Icon = !enabled ? permissionStrengthIcon("relaxed") : levelIcon(effectiveLevel ?? config.levels[0]);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className={`composer-bar-btn security size-7 rounded-md text-foreground hover:bg-muted/60 ${enabled ? "security-active" : "opacity-60"}`} disabled={props.disabled || saving} aria-label={t("security.menuTitle")} title={`${t("security.menuTitle")}: ${levelName}`}>
					<Icon size={15} strokeWidth={2} aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={4} className="min-w-56">
				{/* 顶部状态提示行：启用时说明生效方式，停用时给出开启入口指引 */}
				<div className="border-b border-border/60 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">{enabled ? t("security.menuHint") : t("security.menuDisabledHint")}</div>
				{config.levels.map((level) => {
					const selected = effectiveLevelId === level.id;
					const ItemIcon = levelIcon(level);
					return (
						<DropdownMenuItem key={level.id} disabled={!enabled || props.disabled || saving} onSelect={() => void handlePick(level.id)} title={level.description} className="min-h-9 gap-2 px-2.5 py-1">
							<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
								<ItemIcon size={14} strokeWidth={2} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{level.name}</span>
							{selected ? <Check size={14} strokeWidth={2} className="shrink-0 text-primary" aria-hidden="true" /> : null}
						</DropdownMenuItem>
					);
				})}
				{enabled && hasSessionOverride && (
					<>
						<DropdownMenuSeparator />
						{/* 清除会话覆盖：跟随全局默认（RotateCcw 语义：回退到全局策略） */}
						<DropdownMenuItem disabled={props.disabled || saving} onSelect={() => void handlePick(null)} className="min-h-9 gap-2 px-2.5 py-1">
							<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
								<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{t("security.followDefault")}</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
