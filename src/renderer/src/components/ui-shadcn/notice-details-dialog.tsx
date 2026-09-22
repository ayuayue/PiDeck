import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { writeClipboard } from "../../utils/clipboard";
import { openInSystemBrowser } from "../../utils/openExternal";
import { MarkdownStream } from "../session/MarkdownStream";
import { Button } from "./button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";
import { KIND_ICON, type NoticeDetailsPayload } from "./notice-toast";

/**
 * 长文本「查看详情」弹窗宿主：由 Toaster 常驻挂载（不随单条 toast 生命周期销毁），
 * 展示 showNotice 传入的完整标题与正文。复制按钮复制全文，与 toast 卡片一致。
 * 触发入口是 notice-toast 的卡片（openNoticeDetails），两者分离的原因见下。
 *
 * ## 为什么和 NoticeToastCard 分文件
 *
 * 正文要经 MarkdownStream 渲染，而 MarkdownStream → MarkdownLink → utils/notice 会
 * 反向 import notice-toast 的卡片；同住一个文件就形成
 * `notice-toast → MarkdownStream → MarkdownLink → utils/notice → notice-toast`
 * 的循环 import——靠函数声明提升能侥幸跑通，但任一环节改成常量/类就踩 TDZ。
 * 拆开后：notice-toast 只依赖轻量 utils/clipboard（它被 utils/notice 等错误路径
 * 广泛引用），streamdown / mermaid / katex 这些重依赖只挂在「Toaster → 本文件」链上。
 *
 * ## 渲染安全边界
 *
 * toast 详情承载的就是「卡片里被截断的那段完整长文本」，其中公告一类外部数据本身
 * 就是 markdown——不渲染就是满屏 `**` 与 ``` 围栏。纯文本通知（ask / 报错 / 卸载命令）
 * 同样安全：`.markdown-body p` 是 `white-space: pre-wrap`，单个换行照常换行，只有
 * 成对的 `*` / `_` / `#` 才会被当成强调与标题。渲染与会话消息共用同一套 streamdown
 * sanitize 管线（light 关掉代码高亮/mermaid/数学等重插件），禁止绕过它塞
 * dangerouslySetInnerHTML。
 *
 * 标题不进 markdown：标题是单行短文本，`#` / `-` 开头会被误判成标题/列表。
 */
export function NoticeDetailsDialog({ payload, onOpenChange }: { payload: NoticeDetailsPayload | null; onOpenChange: (open: boolean) => void }) {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);
	const { Icon, className: iconColor } = KIND_ICON[payload?.kind ?? "neutral"];

	// 与卡片复制语义一致：有描述时「标题 + 换行 + 正文」，否则仅标题
	const copyText = payload ? (payload.description ? `${payload.title}\n${payload.description}` : payload.title) : "";

	const handleCopy = useCallback(async () => {
		// 与卡片一致走 utils/clipboard：Electron 主进程优先，不依赖 document focus
		const ok = await writeClipboard(copyText);
		if (!ok) return;
		setCopied(true);
		if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
	}, [copyText]);

	useEffect(
		() => () => {
			if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		},
		[],
	);

	return (
		<Dialog open={payload !== null} onOpenChange={onOpenChange}>
			{/* 宽度：DialogContent 基础类自带 `sm:max-w-lg`，而 Tailwind v4 按**类名字母序**产出规则，
			    `[798px]`（`[`）排在 `lg`（`l`）之前 → 基础类反胜、弹窗被压回 512px。所以这里必须写成
			    字母序在 `lg` 之后的形式（`min(...)`，`m` > `l`），与 ChangelogDialog / SettingsModal 同源。
			    纯文本时代 512px 勉强够用，markdown 的代码块/表格更宽，故适度放宽（上限兜住窄视口）。 */}
			<DialogContent className="sm:max-w-[min(798px,calc(100vw-48px))]" data-notice-details-dialog>
				<DialogHeader>
					<DialogTitle>{t("notice.detailsTitle")}</DialogTitle>
				</DialogHeader>
				{payload ? (
					<div className="flex items-start gap-3">
						<span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-muted ${iconColor}`}>
							<Icon className="h-3.5 w-3.5" />
						</span>
						<div className="min-w-0 flex-1 select-text">
							<p className="text-[13px] font-medium leading-5 break-words whitespace-pre-wrap text-text-primary">{payload.title}</p>
							{payload.description ? (
								/* 外层必须显式挂 `markdown-body`：MarkdownStream 自身不挂这个类，而 streamdown 默认
								   根节点是 space-y-4 + text-3xl 标题（见 styles/streamdownChrome.css 头注释），不挂就是
								   把「行距偏疏、标题过大」的官方皮搬进弹窗，长段落还会因缺 min-width:0 横向撑破。
								   滚动上界：公告正文可达数千字并含代码围栏，不限高会把弹窗顶出屏幕；52vh 让标题与
								   复制按钮始终可见，符合「先扫一眼标题再读正文」的阅读顺序。 */
								<div className="markdown-body mt-1.5 max-h-[52vh] overflow-y-auto text-xs text-text-secondary">
									<MarkdownStream text={payload.description} isStreaming={false} light onOpenExternal={openInSystemBrowser} />
								</div>
							) : null}
						</div>
					</div>
				) : null}
				<div className="flex justify-end">
					<Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
						{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
						{copied ? t("copy.success") : t("common.copy")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
