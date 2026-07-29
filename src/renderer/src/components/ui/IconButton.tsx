import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@renderer/lib/utils";

/**
 * 统一图标按钮（shadcn 简洁风）。
 * - ghost：透明底，适合工具栏
 * - outline：细边框面板底，适合与「新会话」同层的头部控件
 * - soft：浅底无强调边框，适合次要操作
 *
 * 左右分栏开关、会话头部右侧栏开关应使用同一 size，避免视觉大小不一致。
 */
export type IconButtonVariant = "ghost" | "outline" | "soft";
export type IconButtonSize = "sm" | "md";

export function IconButton(
	props: ButtonHTMLAttributes<HTMLButtonElement> & {
		label: string;
		children: ReactNode;
		variant?: IconButtonVariant;
		buttonSize?: IconButtonSize;
		/** 开关类控件的按下/展开态 */
		active?: boolean;
	},
) {
	const {
		label,
		children,
		variant = "ghost",
		buttonSize = "sm",
		active = false,
		className,
		type = "button",
		title,
		...buttonProps
	} = props;

	return (
		<button
			{...buttonProps}
			type={type}
			aria-label={label}
			title={title ?? label}
			aria-pressed={active || undefined}
			className={cn(
				"ui-icon-button",
				`ui-icon-button-${variant}`,
				`ui-icon-button-${buttonSize}`,
				active && "active",
				className,
			)}
		>
			{children}
		</button>
	);
}

export function CloseIconButton(props: {
	label: string;
	onClick: () => void;
	className?: string;
}) {
	return (
		<IconButton
			className={cn("modal-close-btn", props.className)}
			label={props.label}
			variant="ghost"
			buttonSize="md"
			onClick={props.onClick}
		>
			<X size={18} strokeWidth={2.2} aria-hidden="true" />
		</IconButton>
	);
}
