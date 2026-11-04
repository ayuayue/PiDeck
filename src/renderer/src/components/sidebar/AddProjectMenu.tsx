import { FolderPlus, Plus, Server } from "lucide-react";
import { useSetAtom } from "jotai";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { useRemoteFeatureAvailable } from "../../hooks/useRemoteFeatureAvailable";
import { useRemoteHostsConfigured } from "../../hooks/useRemoteHostsConfigured";
import { isRemoteAddProjectVisible } from "../../hooks/remoteFeatureVisibility";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

/**
 * 「+ 添加项目」入口。
 *
 * - 本地目录：走现有本地/WSL 目录选择（App 的 projects.add），行为不变；
 * - 远端（SSH）：打开远端登记弹框（选已验证主机 → 输入绝对路径 → canonical 确认 → 登记）。
 *
 * 远端这项要求**已经配好一台可用的 SSH 主机**（useRemoteHostsConfigured）：一台都没有时
 * 这个入口点进去只会落到登记弹框的 no-host 阶段，所以整项不出现；此时菜单只剩本地一项，
 * 触发器直接回到「按钮 → 选目录」，不再套一层没有选择的下拉。
 *
 * 刻意不做成两个都指向同一行为的假菜单项，也不在这里放远端主机管理（那是设备设置）。
 * 通道门禁（正式包不提供远端能力）与主机清单任一条不满足，都按「不出现」处理。
 */
export function AddProjectMenu(props: { onAddLocal: () => void; labeled?: boolean }) {
	const setRemoteOpen = useSetAtom(remoteEnrollDialogOpenAtom);
	const remoteAvailable = useRemoteFeatureAvailable();
	const hostsConfigured = useRemoteHostsConfigured();
	const remoteVisible = isRemoteAddProjectVisible(remoteAvailable, hostsConfigured);

	// labeled：空态里的大号主按钮形态；默认是侧栏分组标题栏的图标按钮形态。
	const trigger = (onClick?: () => void) =>
		props.labeled ? (
			<Button type="button" variant="secondary" size="sm" className="mt-3" title={t("app.addProject")} aria-label={t("app.addProject")} {...(onClick === undefined ? {} : { onClick })}>
				<FolderPlus className="size-3.5" aria-hidden="true" />
				{t("app.addProject")}
			</Button>
		) : (
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-bg-hover hover:text-foreground"
				aria-label={t("app.addProject")}
				title={t("app.addProject")}
				{...(onClick === undefined ? {} : { onClick })}
			>
				<Plus className="size-3.5" aria-hidden="true" />
			</Button>
		);

	// 只有一个入口时不套下拉：直接开本地目录选择，少一次「先点开菜单再选唯一一项」。
	if (!remoteVisible) return trigger(props.onAddLocal);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
			<DropdownMenuContent align={props.labeled ? "center" : "end"} sideOffset={4} className="min-w-44">
				<DropdownMenuItem onSelect={() => props.onAddLocal()}>
					<FolderPlus className="size-3.5" aria-hidden="true" />
					{t("sidebar.addProjectLocal")}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => setRemoteOpen(true)}>
					<Server className="size-3.5" aria-hidden="true" />
					{t("sidebar.addProjectRemote")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
