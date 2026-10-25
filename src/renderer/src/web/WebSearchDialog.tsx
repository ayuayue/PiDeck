/**
 * Web 端会话内消息搜索（Ctrl+K / 头部按钮打开）。
 *
 * 检索优先级见 `useWebSessionSearch`：后端全会话检索（session-index sidecar / DSH 历史
 * 投影）→ 后端不可用时回退「已加载消息」本地扫描并提示范围受限。命中项点击后滚动定位
 * 到消息并闪烁高亮；锚点由父组件提供 scrollToMessage(id)。
 */
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { UIMessage } from "ai";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { useWebSessionSearch } from "./useWebSessionSearch";

export function WebSearchDialog({ open, onOpenChange, sessionId, messages, onJump }: { open: boolean; onOpenChange: (open: boolean) => void; sessionId?: string; messages: UIMessage[]; onJump: (messageId: string) => void }) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setQuery("");
			// 打开后聚焦输入框（移动端弹键盘，桌面端直接可输入）
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	const { hits, remote, unavailable, hitCount, searching } = useWebSessionSearch(sessionId, query, messages, open);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Search className="size-4" />
						{t("web.searchTitle")}
						{remote && hitCount > hits.length ? <span className="text-micro font-normal text-text-muted">{t("web.searchHitCount", { count: hitCount })}</span> : null}
					</DialogTitle>
				</DialogHeader>
				<Input ref={inputRef} value={query} placeholder={t("web.searchPlaceholder")} onChange={(event) => setQuery(event.target.value)} className="h-9" />
				<div className="max-h-[50dvh] overflow-y-auto">
					{query.trim() && hits.length === 0 && !searching ? (
						<p className="py-6 text-center text-sm text-text-muted">{t("web.searchEmpty")}</p>
					) : (
						<ul className="flex flex-col gap-1">
							{hits.map((hit) => (
								<li key={hit.id}>
									<button
										type="button"
										onClick={() => {
											onJump(hit.id);
											onOpenChange(false);
										}}
										className="w-full rounded-md border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-bg-active"
									>
										<span className={`mr-1.5 text-micro ${hit.role === "user" ? "text-primary" : "text-text-muted"}`}>{hit.role === "user" ? "≫" : "≪"}</span>
										<span className="line-clamp-2 text-xs leading-relaxed">{hit.snippet}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				{query.trim() && searching ? <p className="text-micro text-text-muted">{t("web.searching")}</p> : null}
				{query.trim() && !searching ? <p className="text-micro text-text-muted">{unavailable ? t("web.searchScopeHint") : t("web.searchWholeSession")}</p> : null}
			</DialogContent>
		</Dialog>
	);
}
