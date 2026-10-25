"use client";
// Official BeUI sibling helper — beui.dev registry components/motion/action-swap-roll
// 官方源码忠实拷贝（todo-list 完成计数滚动的入口封装）。

import { ActionSwapButton, ActionSwapIcon, ActionSwapText, type ActionSwapButtonProps, type ActionSwapIconProps, type ActionSwapTextProps } from "./action-swap";

export type {
	ActionSwapButtonSize,
	ActionSwapButtonVariant,
	ActionSwapItem,
} from "./action-swap";

export type ActionSwapRollButtonProps = Omit<ActionSwapButtonProps, "animation">;
export type ActionSwapRollTextProps = Omit<ActionSwapTextProps, "animation">;
export type ActionSwapRollIconProps = Omit<ActionSwapIconProps, "animation">;

export function ActionSwapRollButton(props: ActionSwapRollButtonProps) {
	return <ActionSwapButton {...props} animation="roll" />;
}

export function ActionSwapRollText(props: ActionSwapRollTextProps) {
	return <ActionSwapText {...props} animation="roll" />;
}

export function ActionSwapRollIcon(props: ActionSwapRollIconProps) {
	return <ActionSwapIcon {...props} animation="roll" />;
}
