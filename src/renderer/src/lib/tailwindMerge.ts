import { extendTailwindMerge } from "tailwind-merge";

/**
 * 项目自定义字号 token（对应 styles/tailwind.css 的 @theme --text-* → text-* utility）。
 * 顺序与 tailwind.css 一致；新增 token 必须同步此表，否则 cn() 会把它当颜色类吞掉
 * （守卫：tests/uiFontSizeConsistency.test.mjs 逐项比对 CSS 声明）。
 */
export const PROJECT_TEXT_SIZE_TOKENS = ["micro", "tab", "caption", "control", "widget", "widget-item", "widget-detail", "body", "chat", "chat-row", "chat-detail", "input", "title", "brand", "heading"] as const;

/**
 * 供 cn() 使用的 tailwind-merge 实例：把项目字号挂进 text 主题刻度。
 *
 * 为什么必须显式注册（#389）：tailwind-merge 默认配置只认识内置 tshirt 字号，其余
 * text-* 一律落到 text-color 组的兜底验证器；同组冲突时后写者获胜，于是
 * cn("text-control", "text-primary-foreground") 会把 text-control 整条删掉，元素退回
 * 继承容器字号——表现为设置弹窗按钮忽大忽小、文件类型徽标比文件名还大、文件树激活行
 * 不跟随「界面字号」档位。注册后字号归 font-size 组、文字颜色归 text-color 组，两者
 * 共存；字号彼此仍按后者覆盖（cn("text-micro", "text-sm") === "text-sm"）。
 */
export const twMerge = extendTailwindMerge({
	extend: {
		theme: {
			text: [...PROJECT_TEXT_SIZE_TOKENS],
		},
	},
});
