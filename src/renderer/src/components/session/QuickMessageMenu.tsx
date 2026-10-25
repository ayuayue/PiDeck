import { useSetAtom } from "jotai";
import { MessageSquareText } from "lucide-react";
import { t } from "../../i18n";
import { formatAccelerator, toAriaKeyShortcuts } from "../../../../shared/shortcuts";
import { openSettingsAtom } from "../../atoms";
import { useQuickMessages } from "../../hooks/useQuickMessages";
import { useQuickMessagePopover } from "../../hooks/useQuickMessagePopover";
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { QuickMessagePicker } from "./QuickMessagePicker";

/**
 * 输入框底栏「快捷消息」入口（在安全等级/权限控制位的右侧）。
 *
 * 这里只做浮层宿主：读文件、搜索、分页、行内动作都在 QuickMessagePicker 内，
 * 数据来自配置文件 userData/quick-messages.json（useQuickMessages 负责读写，
 * 用户手工编辑该文件同样立刻生效）。
 *
 * 浮层用 Popover 而不是 DropdownMenu：菜单是「一列铺到底」的形状，条目上限 30 条时
 * 会顶穿窗口（16 条就已经高过屏幕），而 Popover 里能放搜索框 + 分页 + 固定行高的表格。
 * 直发走 controller 的 sendQuickMessage，正文不经过草稿，也不会动用户写了一半的输入
 * （契约见 useSessionSend 的 overrideText）。
 *
 * 开合状态不在这里用 useState：快捷键呼出与点击入口必须共享同一份状态，且都要在
 * 打开前重读文件，统一由 useQuickMessagePopover 持有（见该 hook 的注释）。
 */
export function QuickMessageMenu(props: {
	/** 本栏会话 id：快捷键广播按聚焦栏去重时需要它。 */
	sessionId: string;
	/** Agent 启动中：整个入口禁用（与底栏其它按钮一致）。 */
	disabled?: boolean;
	/** 直发不可用（DSH 模型不可路由 / 生图进行中）：仍可插入草稿，只是不给直发。 */
	sendDisabled?: boolean;
	onInsert: (text: string) => void;
	onSend: (text: string) => void;
}) {
	const { items, loading, error, openFile, refresh } = useQuickMessages();
	const openSettings = useSetAtom(openSettingsAtom);
	// useQuickMessages.refresh 返回快照（Promise<QuickMessagesSnapshot | null>），
	// 而 hook 参数类型是 () => void | Promise<void>：包一层吞掉返回值，避免类型不兼容。
	const { open, setOpen } = useQuickMessagePopover({ sessionId: props.sessionId, refresh: () => void refresh() });
	// 按钮 tooltip 顺带展示当前生效键位（跟随设置页自定义），让快捷键可被发现。
	// aria-keyshortcuts 要 ARIA 语法（Control+Shift+M），不能直接挂展示用的 "⌘⇧M"。
	const { bindings, platform } = useShortcutBindings();
	const shortcutKbd = bindings ? formatAccelerator(bindings.openQuickMessages, platform) : undefined;
	const shortcutAria = bindings ? toAriaKeyShortcuts(bindings.openQuickMessages, platform) : undefined;
	const triggerTitle = shortcutKbd ? `${t("app.quickMessagesTitle")} (${shortcutKbd})` : t("app.quickMessagesTitle");

	return (
		<Popover
			open={open}
			// setOpen（hook 内的单一写入口）会负责「打开时重读文件」；Radix 的 Esc / 点外部
			// 收起也走这里，所以收起不需要额外处理。
			onOpenChange={setOpen}
		>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon" className="composer-bar-btn quick-messages icon size-7 rounded-md text-foreground hover:bg-muted/60" aria-label={t("app.quickMessagesTitle")} aria-keyshortcuts={shortcutAria} title={triggerTitle} disabled={props.disabled}>
					<MessageSquareText size={15} strokeWidth={2} aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			{/*
			 * 宽度按内容给足（长条目截断而不是撑破），并留出兜底：窄窗口下最多占到视口宽减两指。
			 * 打开后焦点落在搜索框里（Radix 聚焦首个可聚焦元素），插入完再由 controller 交回输入框。
			 */}
			<PopoverContent side="top" align="start" sideOffset={6} className="w-[26rem] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0">
				<QuickMessagePicker
					items={items}
					loading={loading}
					error={error}
					sendDisabled={props.sendDisabled}
					onInsert={(text) => {
						// Popover 与菜单不同：点内容不会自动收起，两个动作都要显式关。
						// 先关再插入（插入会把焦点交回输入框，顺序反了焦点会被收起动作抢回去）。
						setOpen(false);
						props.onInsert(text);
					}}
					onSend={(text) => {
						setOpen(false);
						props.onSend(text);
					}}
					// 两个出口都离开弹框：打开的是系统编辑器 / 跳到设置页，留着浮层只会在回来时显示陈旧内容
					onOpenFile={() => {
						setOpen(false);
						void openFile();
					}}
					onManage={() => {
						setOpen(false);
						openSettings({ tab: "common", section: "common-quick-messages" });
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
