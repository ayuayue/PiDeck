import { clsx, type ClassValue } from "clsx";
// 自定义字号 token 已注册（#389）：直接用 tailwind-merge 的 twMerge 会把 text-micro /
// text-control 等当颜色类吞掉。cn 的结构保持 shadcn 官方原版，只替换 merge 实例来源。
import { twMerge } from "./tailwindMerge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
