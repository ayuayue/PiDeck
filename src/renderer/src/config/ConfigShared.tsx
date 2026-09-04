import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { t } from "../i18n";
import { writeClipboard } from "../utils/clipboard";
import { PROVIDER_API_OPTIONS, API_TYPE_LABELS, getApiTypeDescription } from "./providerHeaders";
import { Button } from "../components/ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { Input } from "../components/ui-shadcn/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui-shadcn/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../components/ui-shadcn/command";
import { filterComboboxOptions, isKnownComboboxValue } from "./comboboxOptions";

// ── 复制到剪贴板工具 ──────────────────────────────────

/**
 * 弹框内文档链接统一强制系统浏览器打开：
 * 内置浏览器面板位于 Dialog 下层不可见（linkOpenMode=internal 时会被遮挡），
 * forceSystem 绕过该设置直接 shell.openExternal；保留 href 语义供中键/辅助功能使用。
 */
export function openDocsInSystemBrowser(url: string) {
	return (event: MouseEvent) => {
		event.preventDefault();
		void window.piDesktop.app.openExternal(url, true);
	};
}

export function CopyButton(props: { text: string }) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<number | null>(null);
	useEffect(() => () => {
		if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
	}, []);
	const handleCopy = async (e: MouseEvent) => {
		e.stopPropagation();
		await writeClipboard(props.text);
		if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
		setCopied(true);
		resetTimer.current = window.setTimeout(() => {
			resetTimer.current = null;
			setCopied(false);
		}, 1500);
	};
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			className="size-7"
			onClick={handleCopy}
			title={copied ? t("common.copied") : t("common.copy")}
			aria-label={copied ? t("common.copied") : t("common.copy")}
		>
			{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
		</Button>
	);
}

/** 密码输入框：支持显示/隐藏 + 复制 */
export function SecretInput(props: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="flex w-full items-center gap-1.5">
			<Input
				type={visible ? "text" : "password"}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				placeholder={props.placeholder ?? t("config.apiKeyPlaceholder")}
				className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-7"
				onClick={() => setVisible(!visible)}
				title={visible ? t("common.hide") : t("common.show")}
				aria-label={visible ? t("common.hide") : t("common.show")}
			>
				{visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
			</Button>
			<CopyButton text={props.value} />
		</div>
	);
}

// ── Models Tab ──────────────────────────────────────────

/** Radix Select 不允许空字符串 value，用哨兵值映射回 ""。 */
const SENTINEL = "__none__";

export function ConfigSelect(props: {
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
	/** 外层 ClearableSettingsInput 的 ✕ 清除按钮位于 right-[38px]，
	 *  给 trigger 加右内边距，避免已选文字被清除按钮盖住 */
	clearSpace?: boolean;
}) {
	// 老 settings.json 可能残留枚举外的取值（如自定义传输协议）；此时补一条「自定义」
	// item 兜底，否则 Radix Select 因 value 无匹配 item 而显示空白、且无法回选。
	const hasCustom = props.value !== "" && !isKnownComboboxValue(props.options, props.value);
	return (
		<Select
			value={props.value === "" ? SENTINEL : props.value}
			onValueChange={(value) => props.onChange(value === SENTINEL ? "" : value)}
		>
			{/* trigger 必须带 w-full：shadcn 基础类自带 w-fit（utilities 层）会压过 legacy 的
			    .config-select-trigger{width:100%}，不加则下拉收缩成内容宽度（值多的行长条很丑） */}
			<SelectTrigger className={`config-select-trigger w-full${props.clearSpace ? " pr-[38px]" : ""}`}>
				<SelectValue placeholder={props.placeholder ?? props.options.find((o) => o.value === props.value)?.label ?? props.value} />
			</SelectTrigger>
			<SelectContent>
				{/* Radix Select 的 value 必须匹配某个 item 才能打开：空值走哨兵 value，
				   补一个隐藏 item 保证下拉始终可展开（社区标准模式） */}
				{props.value === "" && <SelectItem value={SENTINEL} className="hidden" aria-hidden="true" />}
				{hasCustom && (
					<SelectItem value={props.value}>
						<span className="flex flex-col items-start gap-0.5">
							<span className="text-control font-semibold">{t("config.apiTypeCustom")}: {props.value}</span>
							<small className="text-[11px] leading-[1.4] text-text-tertiary">{props.value}</small>
						</span>
					</SelectItem>
				)}
				{props.options.map((option) => (
					<SelectItem key={option.value || "none"} value={option.value === "" ? SENTINEL : option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * 通用 combobox（shadcn Popover + Command）：下拉搜索选择 + 无匹配时按 Enter 提交自定义值。
 * 用于 settings 中 defaultProvider / defaultModel 等需要从已有配置选取但又允许自定义的场景。
 *
 * 为什么用 Radix Popover 而不是旧的手写 portal 面板：
 * 1. 旧面板挂在 body 下，Radix Dialog 的滚动锁（react-remove-scroll）会把它当「锁外内容」
 *    直接 preventDefault 掉滚轮事件，值多的时候下拉永远滚不动；
 * 2. Radix Popover/Select 同层的 dismissable 机制保证点击面板选项不会关掉外层 SettingsDialog；
 * 3. 交互/动画与全局 shadcn 下拉一致。
 * 浮层滚动由 ui-shadcn/popover.tsx 内置的 floatingWheelGuard 兜底（见 lib/floatingWheelGuard）。
 */
export function ConfigComboboxInput(props: {
	value: string;
	options: Array<{ value: string; label?: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
	/** 右侧额外预留清除按钮空间（defaultProvider/defaultModel 清空场景），
	 *  避免输入文字被清除按钮盖住 */
	clearSpace?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const filtered = filterComboboxOptions(props.options, filter);

	// 提交即关闭：选中选项（鼠标/键盘回车命中选项）与无匹配时按 Enter 走同一条路。
	const commit = (value: string) => {
		props.onChange(value);
		setOpen(false);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// 每次打开都重置过滤词，避免上次搜索残留导致列表为空。
				if (next) setFilter("");
			}}
		>
			<PopoverTrigger asChild>
				<Input
					readOnly
					value={props.value}
					placeholder={props.placeholder}
					className={`h-8 min-w-0 w-full flex-1 cursor-pointer rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]${props.clearSpace ? " pr-[62px]" : ""}`}
					onKeyDown={(event) => {
						// readOnly 的 input 不响应键盘激活（不会触发 click），补上 Enter/Space/
						// ArrowDown 打开下拉，保持与原生 select/combobox 一致的键盘可达性。
						if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
							event.preventDefault();
							setOpen(true);
						}
					}}
				/>
			</PopoverTrigger>
			{/* 下拉面板：宽度跟随 trigger（--radix-popover-trigger-width），与旧面板同宽。 */}
			<PopoverContent align="start" sideOffset={4} className="w-[var(--radix-popover-trigger-width)] max-w-[min(680px,calc(100vw-48px))] p-0">
				<Command shouldFilter={false}>
					<CommandInput
						value={filter}
						onValueChange={setFilter}
						placeholder={t("config.comboboxSearchPlaceholder")}
						autoFocus
						onKeyDown={(event) => {
							// 无匹配时 Enter 提交手输值（自定义 provider / model id）；
							// 有匹配时交给 cmdk 的选中项提交，避免双重提交。
							if (event.key === "Enter" && filtered.length === 0 && filter.trim()) {
								event.preventDefault();
								commit(filter.trim());
							}
						}}
					/>
					<CommandList>
						{filtered.length === 0 && (
							<CommandEmpty>{t("config.comboboxNoMatchCommitHint")}</CommandEmpty>
						)}
						{filtered.map((option) => (
							<CommandItem
								key={option.value}
								value={option.value}
								onSelect={() => commit(option.value)}
							>
								<span className="flex min-w-0 flex-1 items-center gap-2 truncate">
									<span className="truncate">{option.label ?? option.value}</span>
								</span>
								{option.value === props.value && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** API 类型选择：shadcn Select（与全局下拉交互/动画一致）。
 *  预定义选项 + 描述；当前值为自定义值时动态追加「自定义」选项保留可读性。 */
export function ApiTypeInput(props: {
	value: string;
	onChange: (value: string) => void;
}) {
	const isCustom = Boolean(props.value) && !PROVIDER_API_OPTIONS.includes(props.value);
	return (
		<Select
			value={props.value || SENTINEL}
			onValueChange={(value) => props.onChange(value === SENTINEL ? "" : value)}
		>
			<SelectTrigger className="config-select-trigger w-full">
				{/* 选中后只显示名称（title），描述仅在下拉选项里展示：
				   不用 SelectValue 的自动文本（会连描述一起显示） */}
				<span className="flex min-w-0 flex-1 items-center truncate">
					{props.value
						? (API_TYPE_LABELS[props.value] || props.value)
						: <span className="text-muted-foreground">{t("config.apiTypePlaceholder")}</span>}
				</span>
			</SelectTrigger>
			<SelectContent>
				{/* 空值（无 API 类型）时补隐藏哨兵 item，保证下拉可展开 */}
				{!props.value && <SelectItem value={SENTINEL} className="hidden" aria-hidden="true" />}
				{isCustom && (
					<SelectItem value={props.value}>
						<span className="flex flex-col items-start gap-0.5">
							<span className="text-control font-semibold">{t("config.apiTypeCustom")}: {props.value}</span>
							<small className="text-[11px] leading-[1.4] text-text-tertiary">{props.value}</small>
						</span>
					</SelectItem>
				)}
				{PROVIDER_API_OPTIONS.map((option) => (
					<SelectItem key={option} value={option}>
						<span className="flex flex-col items-start gap-0.5">
							<span className="text-control font-semibold">{API_TYPE_LABELS[option] || option}</span>
							<small className="text-[11px] leading-[1.4] text-text-tertiary">{getApiTypeDescription(option)}</small>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

