import type { WorkbenchEditorTabItem } from "../session/SessionTabsBar";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

export function WorkbenchFileTabs(props: { tabs: readonly WorkbenchEditorTabItem[]; onSelect: (id: string) => void; onClose: (id: string) => void; onPromote: (id: string) => void }) {
	return (
		<div role="tablist" aria-label={t("app.files")} className="simple-file-tabs flex h-12 min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-2">
			{props.tabs.map((tab) => (
				<div key={tab.id} className="flex min-w-0 shrink-0 items-center gap-1">
					<button
						type="button"
						role="tab"
						aria-selected={tab.active}
						title={tab.title}
						className={cn("max-w-48 truncate rounded px-2 py-1 text-xs", tab.active ? "bg-muted text-foreground" : "text-muted-foreground", tab.preview && "italic")}
						onClick={() => props.onSelect(tab.id)}
						onDoubleClick={() => props.onPromote(tab.id)}
					>
						{tab.label}
					</button>
					<button type="button" aria-label={`${t("tabs.close")} ${tab.label}`} className="rounded p-1 hover:bg-muted" onClick={() => props.onClose(tab.id)}>
						<X className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}
