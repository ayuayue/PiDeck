/**
 * Tab 关闭钮（会话 Tab / 文件 Tab / 插件伪 Tab / 浏览器 Tab 共用）的唯一外观来源。
 *
 * 旧实现三处各自写 `text-muted-foreground/70` + `hover:bg-accent`，有两个看不见的原因：
 * 1) `hover:bg-accent` 解析成 `--color-bg-active`，与「激活 Tab 的选中底色」是同一个值
 *    → 激活 Tab 上的悬停圆圈底色 = 背景色，等于没画；
 * 2) 图标本已是 `muted-foreground/70`，外层再乘 `opacity-60`，双重降透明后接近不可见。
 *
 * 现在：图标用不降透明的 `muted-foreground`，悬停圈改用与底色无关的 `foreground/15`
 * 叠层（明暗主题下都稳定可见），圆形（rounded-full）让「点关闭」的命中区一眼可辨。
 *
 * 尺寸取 20px（size-5）而非 16px：16px 圈在 1080p 下几乎点不中也看不清，
 * VS Code / Chrome 的关闭钮命中区都在 20px 量级，12px 图标居中即可。
 */
export const TAB_CLOSE_BUTTON_CLASS = "inline-grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-[color,background-color,opacity] hover:bg-foreground/15 hover:text-foreground";
