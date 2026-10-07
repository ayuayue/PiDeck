/**
 * WebPromptPicker — Composer 内的提示词库选择器（P2）。
 *
 * 数据源 /api/prompts（XuePromptManager，桌面同一库）；搜索 + 分类筛选，
 * 点击条目拉取正文并回填 composer。独立组件避免 WebComposer 膨胀。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui-shadcn/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { fetchPromptContent, fetchPrompts } from "./webApi";

type PromptItem = { slug: string; title: string; category: string; subcategory: string; tags: string[]; description: string };

export function WebPromptPicker(props: { disabled?: boolean; onPick: (content: string) => void }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string | undefined>(undefined);
	const [categories, setCategories] = useState<Array<{ slug: string; name: string; count: number }>>([]);
	const [prompts, setPrompts] = useState<PromptItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState(false);
	// 搜索防抖（本地 state，不引 jotai）
	const [debounced, setDebounced] = useState("");
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [insertingSlug, setInsertingSlug] = useState<string | null>(null);

	useEffect(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setDebounced(search), 250);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [search]);

	const load = useCallback(async (term: string, cat: string | undefined) => {
		setLoading(true);
		setLoadError(false);
		try {
			const result = await fetchPrompts(term || undefined, cat);
			setCategories(result.categories);
			setPrompts(result.prompts);
		} catch {
			setLoadError(true);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void load(debounced, category);
	}, [open, debounced, category, load]);

	const insert = async (item: PromptItem) => {
		setInsertingSlug(item.slug);
		try {
			const content = await fetchPromptContent(item.slug, item.category);
			props.onPick(content);
			setOpen(false);
		} catch {
			setLoadError(true);
		} finally {
			setInsertingSlug(null);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" size="sm" className="hidden h-8 w-8 shrink-0 p-0 text-muted-foreground sm:inline-flex" disabled={props.disabled} title={t("web.promptLibrary")} aria-label={t("web.promptLibrary")}>
					{/* 纯图标触发器（与相邻 ImagePlus 同规格）。移动窄屏（<sm）隐藏：模型/思考/图片是核心，
					   提示词库是增强，5 个元素在窄屏装不下会溢出把发送按钮挤折叠；宽屏再显示。 */}
					<Sparkles className="size-4" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-96 p-0">
				<div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
					<Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("web.promptSearchPlaceholder")} className="h-7 border-0 shadow-none focus-visible:ring-0" />
				</div>
				{categories.length > 0 ? (
					<div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
						<button type="button" className={cn("shrink-0 rounded-full px-2 py-0.5 text-micro transition-colors", !category ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70")} onClick={() => setCategory(undefined)}>
							{t("web.promptAllCategories")}
						</button>
						{categories.map((cat) => (
							<button key={cat.slug} type="button" className={cn("shrink-0 rounded-full px-2 py-0.5 text-micro transition-colors", category === cat.slug ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70")} onClick={() => setCategory(cat.slug)}>
								{cat.name}
							</button>
						))}
					</div>
				) : null}
				<div className="max-h-72 overflow-y-auto p-1.5">
					{loadError ? (
						<div className="px-2 py-3 text-center text-caption text-danger">{t("web.promptLoadFailed")}</div>
					) : loading && prompts.length === 0 ? (
						<div className="flex items-center justify-center gap-2 px-2 py-3 text-caption text-muted-foreground">
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							{t("web.promptLibraryLoading")}
						</div>
					) : prompts.length === 0 ? (
						<div className="px-2 py-3 text-center text-caption text-muted-foreground">{t("web.promptEmpty")}</div>
					) : null}
					{prompts.map((item) => (
						<button key={`${item.category}/${item.slug}`} type="button" className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent" disabled={insertingSlug !== null} onClick={() => void insert(item)}>
							<div className="truncate text-control text-foreground">{item.title}</div>
							{item.description ? <div className="mt-0.5 truncate text-micro text-muted-foreground">{item.description}</div> : null}
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
