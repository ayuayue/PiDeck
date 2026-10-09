import { memo, useMemo } from "react";
import { useAtomValue } from "jotai";
import type { AppSettings } from "../../../../../shared/types";
import { HIDEABLE_MODULE_IDS, isModuleHidden, toggleHiddenModule, type HideableModuleId } from "../../../../../shared/hiddenModules";
import { t, type TranslationKey } from "../../../i18n";
import { imageGenConfigAtom, sessionRecordsAtom, sessionRuntimeByIdAtom } from "../../../atoms";
import { useFeishuBridge } from "../../../hooks/useFeishuBridge";
import { Badge } from "../../ui-shadcn/badge";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow } from "./SettingRows";
import { Switch } from "../../ui-shadcn/switch";
import { SETTINGS_TAB_LABEL_KEYS } from "./settingsTabLayout";

type ModuleVisibilitySectionProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
	/** 视觉桥配置里的 enabled（独立文件 pi-deck-vision.json，不在 AppSettings 里）；未加载时为 undefined。 */
	visionEnabled: boolean | undefined;
};

/** 各模块行的标题 key：设置 tab 直接复用侧栏标题（命令面板同源），dsh 用配置管理分页的名字。 */
const MODULE_LABEL_KEYS: Record<HideableModuleId, TranslationKey> = {
	im: SETTINGS_TAB_LABEL_KEYS.im,
	pet: SETTINGS_TAB_LABEL_KEYS.pet,
	vision: SETTINGS_TAB_LABEL_KEYS.vision,
	imagegen: SETTINGS_TAB_LABEL_KEYS.imagegen,
	acp: SETTINGS_TAB_LABEL_KEYS.acp,
	hostplugins: SETTINGS_TAB_LABEL_KEYS.hostplugins,
	web: SETTINGS_TAB_LABEL_KEYS.web,
	git: SETTINGS_TAB_LABEL_KEYS.git,
	usage: SETTINGS_TAB_LABEL_KEYS.usage,
	process: SETTINGS_TAB_LABEL_KEYS.process,
	dsh: "settings.modules.dsh",
};

/** 每个模块隐藏后受影响的入口说明（行描述）。 */
const MODULE_DESC_KEYS: Record<HideableModuleId, TranslationKey> = {
	im: "settings.modules.imDesc",
	pet: "settings.modules.petDesc",
	vision: "settings.modules.visionDesc",
	imagegen: "settings.modules.imagegenDesc",
	acp: "settings.modules.acpDesc",
	hostplugins: "settings.modules.hostpluginsDesc",
	web: "settings.modules.webDesc",
	git: "settings.modules.gitDesc",
	usage: "settings.modules.usageDesc",
	process: "settings.modules.processDesc",
	dsh: "settings.modules.dshDesc",
};

/**
 * 外观设置「功能模块」分区：每个可隐藏模块一行开关（开 = 显示）。
 *
 * 隐藏只收起 UI 入口，不清配置、不停后台功能，所以模块仍在运行/已启用时在标题旁挂
 * 「运行中 / 已启用」徽标——用户关掉入口后不至于忘了它还在跑（issue #248 维护者要求）。
 * 活动状态取自各模块现成的数据源，不新增 IPC：
 * - 飞书：Bridge 连接态（useFeishuBridge 内部订阅 IPC 推送）
 * - DSH：有 backend=dsh 且 runtime 未关闭的会话
 * - 桌宠 / Web 服务 / Git：AppSettings 里对应的启用开关（读草稿，与本页其它项一致）
 * - 视觉桥：pi-deck-vision.json 的 enabled
 * - 生图：已配置至少一个供应商（生图按需请求，无「运行中」概念）
 * 用量统计 / 进程监控只是展示页，没有活动状态。
 */
export const ModuleVisibilitySection = memo(function ModuleVisibilitySection(props: ModuleVisibilitySectionProps) {
	const { draft, updateDraft, isDirty, visionEnabled } = props;
	const hiddenModules = draft.hiddenModules ?? [];
	const feishu = useFeishuBridge();
	const imageGenConfig = useAtomValue(imageGenConfigAtom);
	const sessionRecords = useAtomValue(sessionRecordsAtom);
	const runtimeById = useAtomValue(sessionRuntimeByIdAtom);
	// 会话目录里带 DSH 后端且进程未关闭的会话数：closed/detached 的不算「还在跑」
	const dshActive = useMemo(() => Object.values(sessionRecords).some((record) => record.backend === "dsh" && runtimeById[record.id] !== undefined && runtimeById[record.id]?.status !== "closed" && runtimeById[record.id]?.status !== "detached"), [sessionRecords, runtimeById]);

	const activeBadge = (moduleId: HideableModuleId): TranslationKey | null => {
		switch (moduleId) {
			case "im":
				return feishu.status.status === "connected" ? "settings.modules.statusConnected" : null;
			case "dsh":
				return dshActive ? "settings.modules.statusRunning" : null;
			case "pet":
				return draft.petEnabled ? "settings.modules.statusEnabled" : null;
			case "web":
				return draft.webServiceEnabled ? "settings.modules.statusEnabled" : null;
			case "git":
				return draft.enableGitManagement ? "settings.modules.statusEnabled" : null;
			case "vision":
				return visionEnabled ? "settings.modules.statusEnabled" : null;
			case "imagegen":
				return imageGenConfig.providers.length > 0 ? "settings.modules.statusConfigured" : null;
			case "usage":
			case "process":
			case "acp":
			case "hostplugins":
				return null;
		}
	};

	return (
		/* 锚点供命令面板「功能模块」条目直达（utils/settingsFieldAnchors.ts 登记） */
		<SettingsSection
			id="settings-section-appearance-modules"
			title={
				<span className="inline-flex items-center gap-1.5">
					{t("settings.modules.title")}
					{/* 整组开关共用一个 AppSettings 字段，黄点挂在分区标题而非逐行（逐行会在改一项时全部亮起） */}
					<DirtyMarker dirty={isDirty("hiddenModules")} label={t("settings.modules.title")} />
				</span>
			}
			description={t("settings.modules.sectionDesc")}
		>
			{HIDEABLE_MODULE_IDS.map((moduleId) => {
				const hidden = isModuleHidden(hiddenModules, moduleId);
				const label = t(MODULE_LABEL_KEYS[moduleId]);
				const badgeKey = activeBadge(moduleId);
				return (
					<SettingRow
						key={moduleId}
						title={
							<>
								<span>{label}</span>
								{/* 活动状态徽标：只在模块被隐藏时才有提醒价值，显示中的模块状态在它自己的页面里看 */}
								{hidden && badgeKey ? (
									<Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground">
										{t(badgeKey)}
									</Badge>
								) : null}
							</>
						}
						description={t(MODULE_DESC_KEYS[moduleId])}
					>
						<Switch checked={!hidden} onCheckedChange={(checked) => updateDraft({ hiddenModules: toggleHiddenModule(hiddenModules, moduleId, !checked) })} aria-label={label} />
					</SettingRow>
				);
			})}
		</SettingsSection>
	);
});
