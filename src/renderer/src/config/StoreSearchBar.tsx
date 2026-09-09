import { forwardRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { Input as MotionInput } from "../components/motion/input";
import { Button } from "../components/ui-shadcn/button";
import { cn } from "../lib/utils";
import { t } from "../i18n";

/**
 * 商店搜索栏（beui input 胶囊封装）——统一 5 处商店搜索外观：
 * 扩展商店 / SkillHub / 技能商店 / 提示词商店 / 中文精选。
 *
 * 替代各页手写的 prompt-store-search-* / skillhub-search-* CSS：旧观感是
 * 「外层大圆角容器 + 内嵌方角 Input + 黑色按钮」的双层边框，这里收敛为
 * 单个 beui input 胶囊（左侧放大镜，右侧同高圆角按钮，加载时按钮转 spinner）。
 *
 * 交互不变：远程搜索仍由调用方在 onSearch / onChange / onKeyDown 中发起；
 * suggestions 为可选热门词 chips（统一 Tailwind utility，不再各自写类）。
 */
export type StoreSearchBarProps = {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	/** 提供则渲染右侧搜索按钮（icon-only）；不提供则为纯输入框（如输入即搜的页面）。 */
	onSearch?: () => void;
	/** 搜索按钮禁用条件（如空输入 / 加载中）。 */
	searchDisabled?: boolean;
	/** 搜索进行中：输入框禁用 + 按钮转 spinner。 */
	searching?: boolean;
	/** 热门搜索建议 chips（可选）。 */
	suggestions?: string[];
	onSuggestionClick?: (suggestion: string) => void;
	className?: string;
	autoFocus?: boolean;
	onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
};

export const StoreSearchBar = forwardRef<HTMLInputElement, StoreSearchBarProps>(
	function StoreSearchBar(
		{
			value,
			onChange,
			placeholder,
			onSearch,
			searchDisabled,
			searching = false,
			suggestions,
			onSuggestionClick,
			className,
			autoFocus,
			onKeyDown,
		},
		ref,
	) {
		return (
			<div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
				<div className="flex min-w-0 items-center gap-2">
					{/* beui input 胶囊搜索框：h-9 对齐应用控件节奏（官方默认 h-11 偏大）；
					    disabled/autoFocus/onKeyDown 均透传，受控值走 value+onChange。 */}
					<MotionInput
						ref={ref}
						value={value}
						onChange={onChange}
						placeholder={placeholder}
						disabled={searching}
						autoFocus={autoFocus}
						onKeyDown={onKeyDown}
						leftIcon={<Search />}
						className="min-w-0 flex-1"
						classNames={{
							field: "h-9",
							input: "text-[13px]",
						}}
					/>
					{onSearch ? (
						<Button
							variant="default"
							size="icon-sm"
							className="size-9 shrink-0 rounded-full"
							onClick={onSearch}
							disabled={searchDisabled || searching}
							aria-label={t("common.search")}
							title={t("common.search")}
						>
							{searching ? (
								<Loader2 size={14} className="animate-pideck-spin" />
							) : (
								<Search size={14} strokeWidth={1.8} />
							)}
						</Button>
					) : null}
				</div>
				{suggestions && suggestions.length > 0 ? (
					<div className="flex flex-wrap gap-1.5">
						{suggestions.map((s) => (
							<Button
								key={s}
								variant="ghost"
								size="sm"
								className="h-7 rounded-full border border-border-subtle bg-bg-muted px-2.5 text-caption font-normal text-text-secondary hover:border-accent hover:bg-accent-soft hover:text-accent"
								onClick={() => onSuggestionClick?.(s)}
							>
								{s}
							</Button>
						))}
					</div>
				) : null}
			</div>
		);
	},
);
