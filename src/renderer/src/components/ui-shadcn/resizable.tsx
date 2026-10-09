import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * shadcn Resizable（react-resizable-panels v4 适配版）。
 *
 * 官方 resizable.tsx 面向 v2/v3 的 PanelGroup/PanelResizeHandle 命名；
 * 本项目锁 v4（Group/Panel/Separator），故在此封装同名语义组件，
 * 业务侧（AppShell/SessionView）统一用 shadcn 原语而非裸库调用。
 *
 * v4 关键语义（与 v2/v3 data-panel-group-direction 不同）：
 * - Group 只挂 data-group；flex-direction 由库 inline style 按 orientation 设置
 * - Separator 挂 aria-orientation，且与 Group 方向**相反**（WAI-ARIA）：
 *   - Group horizontal → Separator aria-orientation=vertical（竖线，左右拖）
 *   - Group vertical   → Separator aria-orientation=horizontal（横线，上下拖）
 * - 拖拽中状态是 data-separator="active"，没有 data-resizing / is-resizing
 */
const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.Group>) => (
	<ResizablePrimitive.Group
		className={cn(
			// Group 的 flex-direction 由库 inline style 按 orientation 设置；这里只补满尺寸
			"flex h-full w-full",
			className,
		)}
		{...props}
	/>
);

const ResizablePanel = ResizablePrimitive.Panel;

const ResizableHandle = ({
	withHandle,
	className,
	children,
	...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
	withHandle?: boolean;
}) => (
	<ResizablePrimitive.Separator
		className={cn(
			// 默认按「竖线分隔条」处理（Group horizontal → aria-orientation=vertical）
			"relative flex h-full w-px items-center justify-center bg-border outline-none",
			"after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
			"focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
			// Group vertical → aria-orientation=horizontal：必须铺满宽度，否则命中区只剩 1px 竖条
			"aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
			"aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0",
			className,
		)}
		{...props}
	>
		{/* 调用方自定义把手（如右侧边栏的居中把手）；须显式渲染，否则会被下方的子节点覆盖 */}
		{children}
		{withHandle && (
			<div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
				<GripVertical className="size-2.5" />
			</div>
		)}
	</ResizablePrimitive.Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
