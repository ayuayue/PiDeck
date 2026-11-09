import { ArrowUpDown } from "lucide-react";
import type { ProjectSortModeId } from "../../../../shared/types/project";
import { normalizeProjectSortMode } from "../../../../shared/projectSort";
import { PROJECT_SORT_MODES } from "../../projectSortModes";
import { t } from "../../i18n";
import { DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "../ui-shadcn/dropdown-menu";

export function ProjectSortMenu(props: { mode: ProjectSortModeId; onChange: (mode: ProjectSortModeId) => void }) {
	return (
		<DropdownMenuGroup>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<ArrowUpDown className="size-3.5" aria-hidden="true" />
					{t("menu.projectSortMode")}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent>
					<DropdownMenuRadioGroup value={props.mode} onValueChange={(value) => props.onChange(normalizeProjectSortMode(value))}>
						{PROJECT_SORT_MODES.map((option) => (
							<DropdownMenuRadioItem key={option.id} value={option.id}>
								{t(option.labelKey)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</DropdownMenuGroup>
	);
}
