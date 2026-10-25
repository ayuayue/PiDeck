import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

/**
 * shadcn Tabs 组件（基于 radix-ui 聚合包）。
 *
 * variant 说明：
 * - default（默认）：分段条容器（bg-muted p-1 圆角）+ 白底高亮 trigger，适合页面/分组级切换；
 * - line：无容器下划线式（底部横线 + 选中下划线描边），适合内容区内部的次级页面切换，
 *   避免与上层 segmented 重复（如配置管理内 Pi/DSH，上层已是「系统设置/配置管理」分段条）。
 */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
	return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List> & {
	variant?: "default" | "line";
};

function TabsList({ className, variant = "default", ...props }: TabsListProps) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn(
				"inline-flex h-auto w-full items-center gap-0.5 rounded-md border border-border-subtle bg-bg-muted p-1 text-text-tertiary",
				// line：去掉容器，改为内容区顶部的下划线导航（trigger 自带下划线描边）
				variant === "line" && "w-full justify-start gap-0 rounded-none border-0 border-b border-border bg-transparent p-0",
				className,
			)}
			{...props}
		/>
	);
}

type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger> & {
	variant?: "default" | "line";
};

function TabsTrigger({ className, variant = "default", ...props }: TabsTriggerProps) {
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-sm border border-transparent bg-transparent px-4 py-1.5 text-control whitespace-nowrap !text-[color:var(--color-text-secondary)] shadow-none transition-colors hover:!text-[color:var(--color-text-primary)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-border-subtle data-[state=active]:bg-bg-panel data-[state=active]:!text-[color:var(--color-text-primary)] data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				// line：无盒子，仅下划线选中态（border-b-2），选中颜色用主题 primary
				variant === "line" &&
					"rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-2 !text-[color:var(--color-text-secondary)] shadow-none hover:border-border/60 hover:!text-[color:var(--color-text-primary)] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:!text-[color:var(--color-text-primary)] data-[state=active]:shadow-none",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
	return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-hidden", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
