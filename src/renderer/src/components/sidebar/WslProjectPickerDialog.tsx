import { useAtom } from "jotai";
import { useCallback, useState } from "react";
import { WSL_DIRECTORY_CODES } from "../../../../shared/types/wslDirectory";
import { wslProjectPickerAtom } from "../../atoms/wsl-project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { DirectoryBrowser, type DirectoryLoadResult } from "./DirectoryBrowser";

/**
 * WSL 项目目录选择器（`docs/wsl-project-in-distro-io-plan.md` Wave 0）。
 *
 * 取代系统「打开文件夹」对话框：Windows 侧的 `\\wsl.localhost\<distro>\…` 一律按发行版**默认用户**
 * 鉴权，root 档案的 `/root` 递进系统对话框就是「无法访问网络资源」。这里改由主进程以档案的
 * distro+user 在发行版内列目录，路径始终是 Linux 绝对路径，入库前主进程再校验一次。
 *
 * 全应用唯一挂载点（App 装配）：侧栏「+」与设置 → 连接的档案行都只写 `wslProjectPickerAtom`。
 * 添加成功后由宿主刷新项目清单并选中新项目。
 */
export function WslProjectPickerDialog(props: { onAdded: (projectId: string) => void }) {
	const [target, setTarget] = useAtom(wslProjectPickerAtom);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const hostId = target?.hostId;

	const close = useCallback(() => {
		setTarget(null);
		setPath("");
		setError(null);
		setBusy(false);
	}, [setTarget]);

	// 只读浏览：hostId 缺省时主进程按全局 WSL 模式解析发行版/用户。
	const listDirs = useCallback(
		async (next?: string): Promise<DirectoryLoadResult> => {
			const result = await desktopApi.projects.listWslDirectory(next ?? "", hostId);
			return result.ok ? { ok: true, page: { path: result.value.path, entries: result.value.entries, truncated: result.value.truncated } } : { ok: false, code: result.code };
		},
		[hostId],
	);

	const describeDirError = useCallback((code: string) => {
		if (code === WSL_DIRECTORY_CODES.notDirectory || code === WSL_DIRECTORY_CODES.notFound) return t("sidebar.wslPicker.dirMissing");
		if (code === WSL_DIRECTORY_CODES.unreadable) return t("sidebar.wslPicker.dirUnreadable");
		if (code === WSL_DIRECTORY_CODES.unavailable) return t("sidebar.wslPicker.dirUnavailable");
		return t("sidebar.wslPicker.dirFailed", { code });
	}, []);

	const submit = useCallback(async () => {
		if (path === "") return;
		setBusy(true);
		setError(null);
		try {
			const project = await desktopApi.projects.addWslPath(path, hostId);
			close();
			props.onAdded(project.id);
		} catch (caught) {
			// 主进程对「目录不存在/发行版不可用」已经给出人话；只有裸稳定码才需要兜底文案。
			const raw = caught instanceof Error ? caught.message : String(caught);
			setError(/^[A-Z][A-Z0-9_]{2,63}$/u.test(raw) ? t("sidebar.wslPicker.dirUnavailable") : raw);
		} finally {
			setBusy(false);
		}
	}, [close, hostId, path, props]);

	if (target === null) return null;
	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) close();
			}}
		>
			<DialogContent className="max-w-lg" data-testid="wsl-project-picker-dialog">
				<DialogHeader>
					<DialogTitle>{t("sidebar.wslPicker.title")}</DialogTitle>
					<DialogDescription>{t("sidebar.wslPicker.hint")}</DialogDescription>
				</DialogHeader>
				{/* key 绑定档案：换档案必须重新定位，而不是把上一个发行版的目录留着可点。 */}
				<DirectoryBrowser key={hostId ?? "global"} value={path} load={listDirs} describeError={describeDirError} disabled={busy} onChange={setPath} />
				{error !== null ? <p className="text-label text-destructive">{error}</p> : null}
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button disabled={busy || path === ""} onClick={() => void submit()}>
						{t("sidebar.wslPicker.add")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
