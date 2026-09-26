import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import type { AppSettings, MirrorHealthResult, UpdateSourceId } from "../../../../../shared/types/settings";
import { ATOMGIT_HOST, UPDATE_SOURCE_MIRRORS, buildCustomSourceFeedUrl, normalizeCustomMirrorHost } from "../../../../../shared/updateSources";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { updateChannelInfoAtom } from "../../../atoms/channelSwitchAtoms";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingRow } from "./SettingRows";

/** 镜像健康状态点配色：ok=绿（可用）、slow=黄（较慢）、broken=红（不可用）；未探测=灰。 */
const HEALTH_DOT_CLASS: Record<MirrorHealthResult["status"], string> = {
	ok: "bg-emerald-500",
	slow: "bg-amber-500",
	broken: "bg-red-500",
};

/**
 * 设置「版本与更新」下的更新源选择：
 * - 预设下拉：GitHub 官方（null → 原生 app-update.yml 通道）+ 内置镜像清单（域名即地址）；
 * - 选「自定义镜像…」时展开输入框，实时校验前缀（http(s)://）并预览拼接后的 feed URL；
 * - 挂载时自动体检内置镜像（latest.yml + Range 分片），下拉项前显示状态色点与实测速度，
 *   可手动「重新检测」——镜像域名可用性/速度波动大，静态维护不可靠（见 main/update/mirrorHealth.ts）。
 */
export function UpdateSourceSetting(props: { draft: AppSettings; updateDraft: (patch: Partial<AppSettings>) => void }) {
	const { draft, updateDraft } = props;
	const source: UpdateSourceId = draft.updateSource ?? "atomgit";
	// dev 包锁定官方 GitHub 源（与 UpdateService 同款语义）：AtomGit 镜像只分发 stable 产物，
	// dev 的 0.8.0-beta.* 仅存在于 GitHub Releases；此处仅展示层置灰+强制选中，真实强制在主进程。
	const channelInfo = useAtomValue(updateChannelInfoAtom);
	const devLocked = channelInfo?.channel === "dev";
	const effectiveSource: UpdateSourceId = devLocked ? "github" : source;

	// 镜像体检结果（按更新源 id 索引；null 表示尚未完成首次探测）
	const [mirrorHealth, setMirrorHealth] = useState<Record<string, MirrorHealthResult> | null>(null);
	const [probing, setProbing] = useState(false);

	// 当前生效的更新源地址（github = null → 内置官方通道；atomgit → AtomGit generic feed 地址）。
	const activeFeedUrl: string | null = (() => {
		if (source === "github") return null;
		const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
		return mirror ? buildCustomSourceFeedUrl(mirror.host) : buildCustomSourceFeedUrl(ATOMGIT_HOST);
	})();

	// 并行体检内置更新源；期间锁定 probing，防止重复触发（重新检测按钮也走同一入口）。
	const probeMirrors = useCallback(async () => {
		if (probing) return;
		setProbing(true);
		try {
			const results = await desktopApi.app.checkUpdateMirrors();
			const byId: Record<string, MirrorHealthResult> = {};
			for (const r of results) byId[r.id] = r;
			setMirrorHealth(byId);
		} catch {
			// 探测失败（IPC 异常）不阻塞设置页：保留上次结果，静默忽略。
			setMirrorHealth(null);
		} finally {
			setProbing(false);
		}
	}, [probing]);

	// 打开设置页即自动体检一次，后续由「重新检测」按钮触发
	useEffect(() => {
		void probeMirrors();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时探测一次
	}, []);

	// 更新源状态点渲染；未探测/探测中显示灰色占位，避免下拉项宽度跳动
	const healthDot = (id: string) => {
		const h = mirrorHealth?.[id];
		if (!h) return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
		return <span className={`size-1.5 rounded-full ${HEALTH_DOT_CLASS[h.status]}`} />;
	};

	// 更新源行右侧的实测速度/延迟文本（broken 时显示原因）
	const healthText = (id: string) => {
		const h = mirrorHealth?.[id];
		if (!h) return null;
		if (h.status === "ok") return t("settings.updateMirrorOk", { speed: h.speedKBps, latency: h.latencyMs });
		if (h.status === "slow") return t("settings.updateMirrorSlow", { speed: h.speedKBps, latency: h.latencyMs });
		return t("settings.updateMirrorBroken", { error: h.error ?? "?" });
	};

	return (
		<>
			<SettingRow
				title={t("settings.updateSource")}
				description={
					// 描述区直接展示当前生效的完整 feed URL
					activeFeedUrl ? t("settings.updateSourceFeedPreview", { url: activeFeedUrl }) : t("settings.updateSourceFeedOfficial")
				}
			>
				<Select value={effectiveSource} onValueChange={(value) => updateDraft({ updateSource: devLocked ? "github" : (value as UpdateSourceId) })}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{/* AtomGit 第一首选；dev 包置灰禁选（预发布通道固定 GitHub，见 updateSourceDevLocked 说明行） */}
						{UPDATE_SOURCE_MIRRORS.map((mirror) => (
							<SelectItem key={mirror.id} value={mirror.id} disabled={devLocked} className={devLocked ? "opacity-60" : undefined}>
								<span className="flex items-center gap-2">
									{healthDot(mirror.id)}
									<span>{t("settings.updateSourceAtomGit")}</span>
									{healthText(mirror.id) && <span className="text-muted-foreground">{healthText(mirror.id)}</span>}
								</span>
							</SelectItem>
						))}
						{/* GitHub 官方 */}
						<SelectItem value="github">{t("settings.updateSourceGithub")}</SelectItem>
					</SelectContent>
				</Select>
			</SettingRow>

			{/* dev 包锁定说明：解释为何 AtomGit 不可选（镜像无预发布产物） */}
			{devLocked && <p className="pl-4 text-xs text-muted-foreground">{t("settings.updateSourceDevLocked")}</p>}

			{/* 体检状态栏：仅 AtomGit 展示；github 官方链路不参与内置探测（dev 锁定后 effective 恒 github，一并隐藏） */}
			{effectiveSource === "atomgit" &&
				(() => {
					const text = mirrorHealth?.atomgit ? healthText("atomgit") : null;
					return (
						<div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
							<span className="flex items-center gap-2">
								{healthDot("atomgit")}
								{probing || !text ? t("settings.updateMirrorChecking") : text}
							</span>
							<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={probing} onClick={() => void probeMirrors()}>
								{t("settings.updateMirrorRetest")}
							</Button>
						</div>
					);
				})()}
		</>
	);
}
