import { useState } from "react";
import { useSetAtom } from "jotai";
import { MessageSquareText } from "lucide-react";
import { t } from "../../i18n";
import { openSettingsAtom } from "../../atoms";
import { useQuickMessages } from "../../hooks/useQuickMessages";
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
 */
export function QuickMessageMenu(props: {
	/** Agent 启动中：整个入口禁用（与底栏其它按钮一致）。 */
	disabled?: boolean;
	/** 直发不可用（DSH 模型不可路由 / 生图进行中）：仍可插入草稿，只是不给直发。 */
	sendDisabled?: boolean;
	onInsert: (text: string) => void;
	onSend: (text: string) => void;
}) {
	const { items, loading, error, openFile, refresh } = useQuickMessages();
	const openSettings = useSetAtom(openSettingsAtom);
	const [open, setOpen] = useState(false);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// 打开时重读文件：用户可以手工编辑 quick-messages.json，弹框必须显示磁盘上的最新清单，
				// 而不是上次挂载时的快照（主进程侧本来就不缓存，重读成本只是一次小文件读）。
				if (next) void refresh();
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon" className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60" aria-label={t("app.quickMessagesTitle")} title={t("app.quickMessagesTitle")} disabled={props.disabled}>
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
