import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Settings2, SlidersHorizontal, Zap } from "lucide-react";
import { t } from "../../i18n";
import { formatAccelerator } from "../../../../shared/shortcuts";
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";

/**
 * localStorage 键：看过的引导不再弹。
 * 带 `pideck:` 前缀，与 `pideck:welcome-model` 等本地偏好同族。
 */
const ONBOARDING_SEEN_KEY = "pideck:command-palette-onboarding";

/**
 * 启动后延迟弹出：让首屏渲染与会话恢复先完成，避免引导盖在加载态上。
 * 2.5s 是「首屏基本稳定」与「用户还没进入心流」之间的折中——再晚用户已经在打字了。
 */
const ONBOARDING_DELAY_MS = 2500;

function hasSeenOnboarding(): boolean {
	try {
		return localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
	} catch {
		// localStorage 不可用（受限环境）：当作已看过，宁可少提示也不要每次启动都弹
		return true;
	}
}

/**
 * 标记「用户已经知道命令面板了」。
 *
 * 除了引导自己的关闭按钮，宿主在**用户主动打开命令面板**时也应调用它——
 * 自己摸到 Ctrl+P 的人不需要再被引导，否则会出现「已经用得很熟，某次启动仍被弹一脸」。
 */
export function markCommandPaletteOnboardingSeen(): void {
	try {
		localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
	} catch {
		// 写不进去就罢了：最坏下次再弹一次，不值得为它打断用户
	}
}

/** 引导里的一行「能搜到什么」。 */
function ExampleRow(props: { icon: LucideIcon; label: string; description: string }) {
	const Icon = props.icon;
	return (
		<div className="flex items-start gap-2.5">
			<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div className="min-w-0">
				<span className="text-control font-medium text-foreground">{props.label}</span>
				<p className="text-caption leading-relaxed text-muted-foreground">{props.description}</p>
			</div>
		</div>
	);
}

/**
 * 命令面板的首次启动引导。
 *
 * 存在的理由：命令面板是**纯键盘**入口，没有任何可点击的 UI affordance，
 * 用户不会「偶然发现」它——不做一次性提示就等于不存在。
 *
 * 用项目已有的 Dialog（Radix）而不是自绘浮层：焦点陷阱、Esc 关闭、遮罩点击、
 * 无障碍标注都是现成的，这些正是自绘最容易漏的地方。
 *
 * 只弹一次：任何关闭方式（按钮 / Esc / 点遮罩）都写 localStorage，否则会退化成
 * 「每次启动都弹」，比不弹更烦人。
 */
export function CommandPaletteOnboarding(props: {
	/**
	 * 是否允许自动弹出。由宿主判定：应用已就绪 + 已有项目/会话。
	 * 空状态下弹「搜索设置和操作」没有意义——面板本身也没什么可搜的。
	 */
	enabled: boolean;
	/** 「立即试试」：先记账再关引导，然后立刻打开命令面板 */
	onTryNow: () => void;
}) {
	const [open, setOpen] = useState(false);
	// 键位跟随用户自定义（与侧栏 kbd 提示同一份解析实现），不硬编码 Ctrl+P
	const { bindings, platform } = useShortcutBindings();
	const shortcut = bindings ? formatAccelerator(bindings.openCommandPalette, platform) : "Ctrl+P";

	useEffect(() => {
		if (!props.enabled || hasSeenOnboarding()) return;
		const timer = window.setTimeout(() => setOpen(true), ONBOARDING_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [props.enabled]);

	const close = useCallback(
		(tryNow: boolean) => {
			markCommandPaletteOnboardingSeen();
			setOpen(false);
			if (tryNow) props.onTryNow();
		},
		[props],
	);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Esc / 点遮罩也算「已了解」：用户已经看到了内容
				if (!next) markCommandPaletteOnboardingSeen();
				setOpen(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("command.onboarding.title")}</DialogTitle>
					<DialogDescription>{t("command.onboarding.desc", { shortcut })}</DialogDescription>
				</DialogHeader>

				{/* 键帽：整条快捷键一个大 kbd，比拆成多个小键帽更好认（macOS 下是 ⌘P 单字符） */}
				<div className="flex justify-center py-1">
					<kbd className="rounded-md border border-border bg-bg-muted/40 px-3 py-1.5 font-mono text-body font-medium text-foreground">{shortcut}</kbd>
				</div>

				<div className="space-y-2.5">
					<p className="text-caption font-semibold tracking-[0.06em] text-muted-foreground">{t("command.onboarding.whatCanSearch")}</p>
					<ExampleRow icon={SlidersHorizontal} label={t("command.onboarding.exampleSettings")} description={t("command.onboarding.exampleSettingsDesc")} />
					<ExampleRow icon={Zap} label={t("command.onboarding.exampleActions")} description={t("command.onboarding.exampleActionsDesc")} />
					<ExampleRow icon={Settings2} label={t("command.onboarding.exampleConfig")} description={t("command.onboarding.exampleConfigDesc")} />
				</div>

				<DialogFooter className="items-center gap-2 sm:justify-between">
					<span className="text-caption text-muted-foreground">{t("command.onboarding.hint")}</span>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="ghost" onClick={() => close(false)}>
							{t("command.onboarding.later")}
						</Button>
						<Button onClick={() => close(true)}>{t("command.onboarding.tryNow")}</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
