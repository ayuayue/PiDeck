import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui-shadcn/button";
import { Switch } from "../../components/ui-shadcn/switch";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { refreshDshAgentPresets } from "../../utils/dshAgentPresets";
import { showNotice } from "../../utils/notice";
import type { DshNamespaceView } from "../DshSchemaForm";
import type { DshSectionApi } from "../dshSchema";
import { presetDisplayDescription, presetDisplayName } from "../dshPresetDisplay";
import { DshConfigEmpty } from "./DshConfigEmpty";

type DshAgentPreset = {
	id: string;
	isDefault: boolean;
	name?: string;
	description?: string;
	broken?: string;
};

/**
 * 预设设置 tab（对齐 dsh-web 的 agent preset 选择/管理）：列出 host 可组合的会话
 * Agent 预设（standard/ptc/minimal/cordis 等），标记当前默认，并支持把任一预设
 * 设为新会话默认（profile 中 agent-preset-registry.selectedDefault，与 dsh-web 的
 * General 设置行同一写入目标；仅对之后新建的会话生效，运行中会话保持原组合）。
 * 保存语义与 Pi 管理页一致：点击「设为默认」只暂存选择，由顶部统一保存提交。
 */
export function DshConfigPresetsTab(props: { writable: boolean; namespace?: DshNamespaceView; onSave: (id: string) => Promise<void>; sectionApi?: DshSectionApi; instanceKey?: string }) {
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const [presets, setPresets] = useState<DshAgentPreset[]>([]);
	const [loading, setLoading] = useState(true);
	/** 暂存的新默认预设 id（未保存；顶部统一保存时提交）。 */
	const [pendingDefault, setPendingDefault] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** agent-team 实验预设（PiDeck 侧设置项，默认关）：即时写入不入统一保存；
	 *  变更只影响之后 fork 的 host，运行中的 DSH 会话需重启才换到新组合。 */
	const [agentTeam, setAgentTeam] = useState(false);
	const [agentTeamLoaded, setAgentTeamLoaded] = useState(false);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setAgentTeam(settings.dshAgentTeamPreset === true);
				setAgentTeamLoaded(true);
			})
			.catch(() => setAgentTeamLoaded(true));
	}, []);

	/** 切换 agent-team 预设：乐观更新 UI，写设置失败回滚；重启 host 后生效。 */
	const toggleAgentTeam = async (checked: boolean) => {
		const prev = agentTeam;
		setAgentTeam(checked);
		try {
			await desktopApi.settings.update({ dshAgentTeamPreset: checked });
			showNotice(t(checked ? "config.dsh.agentTeamPresetOn" : "config.dsh.agentTeamPresetOff"), 4000);
		} catch (saveError) {
			setAgentTeam(prev);
			showNotice(saveError instanceof Error ? saveError.message : String(saveError), 4000);
		}
	};

	const reload = useCallback(async () => {
		try {
			const list = await desktopApi.sessions.listDshAgentPresets();
			setPresets(list);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions
			.listDshAgentPresets()
			.then((list) => {
				if (!cancelled) {
					setPresets(list);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	/** 当前默认预设 id：点选「当前默认」不算修改（与改回原值同语义）。 */
	const currentDefaultId = presets.find((preset) => preset.isDefault)?.id;
	const dirty = pendingDefault !== null;

	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：提交暂存的新默认预设（settings 文档，host 热重载）。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (pendingDefault === null) return true;
		setSaving(true);
		try {
			await props.onSave(pendingDefault);
			setPendingDefault(null);
			await reload();
			// 会话头胶囊读的是共享目录缓存（utils/dshAgentPresets）：不主动刷新的话，
			// 改完默认预设后新建会话仍显示旧默认，发出去才变成新组合。这里 force 重拉，
			// 让已挂载的胶囊立即同步（失败不影响保存结果，胶囊侧保留重试）。
			void refreshDshAgentPresets();
			return true;
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("config.dsh.presetSetDefaultFailed"), 4000);
			return false;
		} finally {
			setSaving(false);
		}
	}, [pendingDefault, props, reload]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	if (loading) {
		return (
			<div className="flex min-h-32 items-center justify-center gap-2 text-control text-muted-foreground">
				<LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}
	return (
		<div className="grid gap-4">
			<p className="text-micro text-muted-foreground">{t("config.dsh.presetsHint")}</p>
			{/* agent-team 实验预设（默认关）：PiDeck 侧开关，即时写入；组合变更需重启 host 生效 */}
			<section className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
				<div className="flex items-center justify-between gap-4">
					<div className="grid gap-0.5">
						<span className="text-caption font-semibold text-foreground">{t("config.dsh.agentTeamPreset")}</span>
						<p className="text-micro text-muted-foreground">{t("config.dsh.agentTeamPresetHint")}</p>
					</div>
					<Switch checked={agentTeam} disabled={!agentTeamLoaded} onCheckedChange={(checked) => void toggleAgentTeam(checked)} />
				</div>
			</section>
			{presets.length === 0 ? (
				<DshConfigEmpty text={t("config.dsh.presetsEmpty")} />
			) : (
				presets.map((preset) => {
					const name = presetDisplayName(preset, t);
					const description = presetDisplayDescription(preset, t);
					const canSetDefault = props.writable && !preset.broken;
					const isPending = pendingDefault === preset.id;
					const isDefault = preset.isDefault || isPending;
					return (
						<section key={preset.id} className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-control font-semibold text-foreground">{name}</span>
								{isDefault && <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-micro font-medium text-success  ">{t("config.dsh.presetDefault")}</span>}
								{canSetDefault && (
									<Button
										type="button"
										variant="secondary"
										size="sm"
										className="h-7"
										disabled={saving}
										onClick={() => {
											const target = isPending ? null : preset.id;
											// 选回当前默认 = 无实际变化，清掉待保存选择而不是标记脏
											setPendingDefault(target === currentDefaultId ? null : target);
										}}
									>
										{isPending ? t("config.dsh.presetPending") : t("config.dsh.presetSetDefault")}
									</Button>
								)}
							</div>
							{description && <p className="mt-1 text-micro text-muted-foreground">{description}</p>}
							{preset.broken && <p className="mt-1 text-micro text-danger">{t("config.dsh.presetBroken", { reason: preset.broken })}</p>}
							{!props.writable && !preset.isDefault && <p className="mt-1 text-micro text-muted-foreground">{t("config.dsh.presetNotWritable")}</p>}
						</section>
					);
				})
			)}
		</div>
	);
}
