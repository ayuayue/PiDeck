import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "../components/motion/tabs";
import { cn } from "../lib/utils";

/**
 * 内容级 tab 切换条（beui underline：静态下划线指示器，不跟随切换做滑动动画）。
 *
 * 层级语言（配置管理区统一规则）：
 * - 页面级（系统设置/配置管理、Pi/DSH 后端）＝ ui-shadcn 分段条（default）；
 * - 内容级（技能/扩展/提示词的「本地/商店」、商店面板内供应商切换）＝ 本组件下划线式。
 * 两种形态互不混用，避免「同款 pill 叠层」造成的割裂感；侧栏活动/聊天/项目
 * pill 仍走 components/motion/tabs 的弹簧指示器，下划线这一档不做动效。
 */
export type ContentTabItem = {
	value: string;
	label: string;
	/** 可选图标（lucide 组件元素），如商店 tab 的 ShoppingBag。 */
	icon?: ReactNode;
};

export function ContentTabs(props: {
	value: string;
	onValueChange: (value: string) => void;
	items: ContentTabItem[];
	/** 紧凑版（面板内二级切换）：text-xs + 更矮的 trigger。 */
	compact?: boolean;
	/** 是否在横向容器中撑满（默认 true）；纵向容器（flex-col）内传 false 防止竖向拉伸。 */
	fill?: boolean;
	/** 追加到 TabsList 的类。 */
	className?: string;
}) {
	const { value, onValueChange, items, compact = false, fill = true, className } = props;
	return (
		<Tabs value={value} onValueChange={onValueChange} variant="underline" className={cn("min-w-0", fill && "flex-1")}>
			<TabsList className={cn("w-full justify-start gap-0", className)}>
				{items.map((item) => (
					<TabsTrigger
						key={item.value}
						value={item.value}
						// 覆盖 beui 默认尺寸（min-h-[44px] text-sm）到应用控件节奏；
						// 指示器 2px（h-0.5）与旧 line variant 的 border-b-2 视觉一致。
						className={cn("min-h-0 gap-1.5 px-3 py-2 text-control font-medium", compact && "px-3 py-1.5 text-xs")}
						indicatorClassName="h-0.5"
					>
						{item.icon}
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
