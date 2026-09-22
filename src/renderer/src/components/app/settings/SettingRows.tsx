import type { ReactNode } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Switch } from "../../ui-shadcn/switch";
import { Textarea } from "../../ui-shadcn/textarea";

/** 已修改但未保存的字段标记：在标签右侧显示一个黄色圆点 */
export function DirtyMarker(props: { dirty: boolean; label: string }) {
	if (!props.dirty) return null;
	return <span className="setting-dirty-marker" title={t("settings.dirtyTooltip")} aria-label={props.label} />;
}

/**
 * 设置内容淡色框：包住一级标题下的二级内容行。
 * 四角圆弧、极淡底色（bg-muted 30%）+ 淡边框；行间分隔线由 SettingRow 自身提供。
 */
export function SettingBox(props: { children: ReactNode }) {
	return <div className="rounded-lg border border-border-subtle/70 bg-bg-muted/30 px-1 pb-1">{props.children}</div>;
}

/**
 * 设置行（UI 2.0 行式布局）：label 左 + 控件右（固定 260px 列），
 * 行间无分隔线（淡色框内由留白分区）。
 *
 * - level=1：一级标题行（单行分区合并用，加粗加大、缩进更小）；
 * - level=2：普通行（标题略缩进，形成与一级的层级差）；
 * - stacked：超长控件（文本输入 / textarea）降级为单列，控件占满整行；
 * - 描述文字不设最大宽度上限，占满左侧列。
 */
export function SettingRow(props: {
	title: ReactNode;
	description?: ReactNode;
	/** 单列堆叠：label 在上、控件占满整行（文本输入 / textarea 等） */
	stacked?: boolean;
	/** 控件右对齐（开关/按钮/步进器默认 true；select 传 false 撑满 260px 列） */
	alignEnd?: boolean;
	/** 1=一级标题行（单行分区合并，加粗加大）；2=普通行（默认） */
	level?: 1 | 2;
	/**
	 * 深链锚点 slug：渲染成 `id="settings-section-<anchor>"`。
	 *
	 * 用途是让命令面板（Ctrl+P）能**精确跳到某一行设置**，而不只是跳到 tab。
	 * 命名统一 `<tab>-<field>`（如 `dev-rpc-timeout`）；全部锚点集中登记在
	 * `utils/settingsFieldAnchors.ts`，并有一条测试断言「索引里的锚点在源码里真的存在」，
	 * 防止改了字段名却忘了同步索引（那样命令面板会跳到一个不存在的 id）。
	 */
	anchor?: string;
	children: ReactNode;
}) {
	const level = props.level ?? 2;
	return (
		<div id={props.anchor ? `settings-section-${props.anchor}` : undefined} className={cn("grid gap-6 border-t border-border-subtle/60 py-1.5 first:border-t-0", level === 1 ? "px-0.5" : "px-1", props.stacked ? "min-h-0 grid-cols-1 items-start" : "min-h-[54px] grid-cols-[minmax(0,1fr)_260px] items-center")}>
			<span className="min-w-0">
				<span className={cn("inline-flex items-center gap-1.5 text-foreground", level === 1 ? "text-body font-bold" : "text-control font-medium")}>{props.title}</span>
				{props.description && <small className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">{props.description}</small>}
			</span>
			<span className={cn("min-w-0", !props.stacked && (props.alignEnd ?? true) && "flex justify-end")}>{props.children}</span>
		</div>
	);
}

/** 带清除按钮的设置控件包装器：值非空时在控件右侧并排显示清除按钮。 */
export function ClearableSettingsInput(props: { empty: boolean; onClear: () => void; children: ReactNode }) {
	return (
		<div className="flex w-full items-center gap-1.5">
			<div className="min-w-0 flex-1">{props.children}</div>
			{!props.empty && (
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="size-6 shrink-0 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
					onMouseDown={(event) => {
						// 阻止清除操作触发选择器的焦点/值变更连锁反应；实际动作放在 click，保留键盘可用性。
						event.preventDefault();
						event.stopPropagation();
					}}
					onClick={(event) => {
						event.stopPropagation();
						props.onClear();
					}}
					title={t("common.clear")}
					aria-label={t("common.clear")}
				>
					<X size={12} aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}

/** 设置页统一的模型选择触发器：右侧显示已选模型，旁边提供清除动作。 */
export function SettingsModelPickerControl(props: { value: string; placeholder: string; onOpen: () => void; onClear: () => void; disabled?: boolean }) {
	return (
		<ClearableSettingsInput empty={!props.value} onClear={props.onClear}>
			<Button type="button" variant="outline" disabled={props.disabled} className="w-full min-w-0 justify-between font-mono text-control" onClick={props.onOpen} title={props.value || props.placeholder} aria-label={props.value || props.placeholder}>
				<span className={cn("min-w-0 truncate", !props.value && "text-muted-foreground")}>{props.value || props.placeholder}</span>
				<ChevronsUpDown size={14} className="flex-none opacity-60" aria-hidden="true" />
			</Button>
		</ClearableSettingsInput>
	);
}

export function SettingSwitchRow(props: {
	title: ReactNode;
	description?: ReactNode;
	checked: boolean;
	disabled?: boolean;
	/** 未保存时在标题旁显示黄点；开关行默认不包 DirtyMarker，不传就没有标识。 */
	dirty?: boolean;
	/** 黄点无障碍标签，缺省用字符串 title。 */
	dirtyLabel?: string;
	/** 深链锚点 slug，见 SettingRow.anchor */
	anchor?: string;
	onChange: (checked: boolean) => void;
}) {
	const dirtyLabel = props.dirtyLabel ?? (typeof props.title === "string" ? props.title : "");
	return (
		<SettingRow
			anchor={props.anchor}
			title={
				<>
					<span>{props.title}</span>
					<DirtyMarker dirty={Boolean(props.dirty)} label={dirtyLabel} />
				</>
			}
			description={props.description}
		>
			<Switch checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
		</SettingRow>
	);
}

/** 长文本设置项：标题/描述在上，textarea 占满整行 */
export function SettingTextarea(props: {
	title: ReactNode;
	description?: ReactNode;
	value: string;
	onChange: (value: string) => void;
	dirty?: boolean;
	dirtyLabel?: string;
	/** 深链锚点 slug，见 SettingRow.anchor */
	anchor?: string;
}) {
	const dirtyLabel = props.dirtyLabel ?? (typeof props.title === "string" ? props.title : "");
	return (
		<SettingRow
			anchor={props.anchor}
			title={
				<>
					<span>{props.title}</span>
					<DirtyMarker dirty={Boolean(props.dirty)} label={dirtyLabel} />
				</>
			}
			description={props.description}
			stacked
		>
			<Textarea value={props.value} rows={8} onChange={(event) => props.onChange(event.target.value)} className="min-h-24 w-full resize-y border-border-subtle bg-bg-input px-3 py-2 font-mono text-sm leading-relaxed text-foreground" />
		</SettingRow>
	);
}
