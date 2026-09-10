import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { ChevronRight, ExternalLink, FolderGit2, Globe, ScrollText, Tag } from "lucide-react";
import type { AppInfo } from "../../../../shared/types";
import { desktopApi } from "../../desktopApi";
import { formatI18nDateTime, t } from "../../i18n";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "../motion/popover-morph";
import { AnimatedBadge } from "../motion/animated-badge";
import { PiLogoCanvas } from "./PiLogoCanvas";
import { Button } from "../ui-shadcn/button";
import { ChangelogDialog } from "./settings/ChangelogDialog";

/** 官网主页：品牌常量入口，与 launchRoutes 保持一致，强制系统浏览器打开。 */
const WEBSITE_URL = "https://ayuayue.github.io/PiDeck/";

interface AboutPopoverProps {
  /** 应用/pi/DSH/pi-ai 版本与时间信息，由 App 从主进程 AppInfo IPC 拉取后传入。 */
  appInfo: AppInfo;
  /** 弹出触发区（BrandLockup 所在容器）；MorphPopoverTrigger 会为其注入点击控制。 */
  children: ReactElement;
}

/**
 * 左上角品牌区「关于」弹框：点击 PiDeck 品牌弹出 MorphPopover，
 * 展示 Logo、应用版本（等宽小字）、开发分支，以及 pi CLI / DSH 运行时 / pi-ai 目录
 * 版本、Electron/Chromium/Node 栈版本、打包/安装时间与官网/GitHub/发布链接。
 */
export function AboutPopover(props: AboutPopoverProps) {
  const openExternal = useCallback((url: string) => {
    void desktopApi.app.openExternal(url, true);
  }, []);
  // 「更新日志」用应用内弹窗（而非外链）展示，与设置页更新卡片共用 ChangelogDialog。
  const [changelogOpen, setChangelogOpen] = useState(false);

  // releasesUrl 形如 https://github.com/ayuayue/PiDeck/releases，去掉 /releases 即仓库主页
  const githubUrl = props.appInfo.releasesUrl.replace(/\/releases\/?$/, "") || WEBSITE_URL;
  const info = props.appInfo;

  return (
    <MorphPopover>
      <MorphPopoverTrigger>{props.children}</MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="start" sideOffset={10} radius={16} className="w-72 overflow-hidden">
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <PiLogoCanvas size={40} autoPlay />
            <div className="min-w-0 flex-1">
              <div className="font-[PiDeckDepartureMono] text-lg font-normal uppercase leading-tight tracking-wide text-foreground">
                PiDeck
              </div>
              {/* 版本号用等宽小字：此前是带 ⓘ 图标的胶囊徽标，图标语义与「查看版本信息」
                  重复，胶囊边框在 40px logo 旁显得笨重；改为纯文本与弹框内版本行同源观感 */}
              <div className="font-mono text-[11px] leading-tight tabular-nums text-muted-foreground">
                v{info.version}
              </div>
            </div>
            {info.devBranch && (
              <AnimatedBadge status="warning" size="sm" bare>
                {t("about.devBranch")}: {info.devBranch}
              </AnimatedBadge>
            )}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">{t("about.description")}</p>

          <div className="flex flex-col gap-1.5">
            <BlockLabel>{t("about.runtimeInfo")}</BlockLabel>
            {/* 探测失败/未安装的版本显示 —，同样保留行结构便于对照 */}
            <VersionRow label="pi CLI" value={info.piVersion} />
            <VersionRow label={t("about.dshVersion")} value={info.dshRuntimeVersion} />
            <VersionRow label={t("about.piAiVersion")} value={info.piAiVersion} />
            <p className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {t("about.runtimeStack", {
                electron: info.electronVersion ?? "—",
                chromium: info.chromeVersion ?? "—",
                node: info.nodeVersion ?? "—",
              })}
            </p>
          </div>

          {(info.buildTime || info.installedAt) && (
            <div className="flex flex-col gap-1.5">
              <BlockLabel>{t("about.timestamps")}</BlockLabel>
              {info.buildTime && <TimeRow label={t("about.buildTime")} value={info.buildTime} />}
              {info.installedAt && <TimeRow label={t("about.installedAt")} value={info.installedAt} />}
            </div>
          )}

          <div className="flex flex-col gap-0.5 border-t border-border/50 pt-2">
            <AboutLinkRow icon={Globe} label={t("about.website")} url={WEBSITE_URL} onOpen={openExternal} />
            <AboutLinkRow icon={FolderGit2} label={t("about.github")} url={githubUrl} onOpen={openExternal} />
            {/* 更新日志：应用内弹窗，不是外链——与上面三行的区别是点开先看内容再决定是否跳浏览器 */}
            <AboutActionRow
              icon={ScrollText}
              label={t("about.changelog")}
              onClick={() => setChangelogOpen(true)}
            />
            <AboutLinkRow icon={Tag} label={t("about.releases")} url={info.releasesUrl} onOpen={openExternal} />
          </div>
        </div>
      </MorphPopoverContent>
      {/* 弹窗挂在 Popover 内容之外（Radix Dialog 自身 portal 到 body）。
          dismissExemptOnOutside：本弹窗是 Popover 内部入口打开的，而 Popover 的外点
          判定按 root/contentRef 判内外、看不见 portal 出去的本弹窗——不豁免的话，
          点「更新日志」的瞬间 Popover 会先把自己关掉。 */}
      <ChangelogDialog
        open={changelogOpen}
        onOpenChange={setChangelogOpen}
        dismissExemptOnOutside
      />
    </MorphPopover>
  );
}

/** 区块小标题（运行时 / 时间），大写跟踪线样式。 */
function BlockLabel(props: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {props.children}
    </div>
  );
}

/** 单行「标签 — 等宽值」：label 左对齐灰字，value 右侧等宽数字；值缺失显示 —。 */
function VersionRow(props: { label: string; value: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-xs text-muted-foreground">{props.label}</span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">{props.value ?? "—"}</span>
    </div>
  );
}

/** 单行时间：ISO 转当前 locale 的可读格式（formatI18nDateTime 已在 i18n 层统一）。 */
function TimeRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-xs text-muted-foreground">{props.label}</span>
      <span className="shrink-0 text-xs tabular-nums text-foreground">{formatI18nDateTime(props.value)}</span>
    </div>
  );
}

/** 关于面板中的单行链接按钮：图标 + 文案 + 外链箭头，点击经系统浏览器打开。 */
function AboutLinkRow(props: {
	icon: typeof Globe;
	label: string;
	url: string;
	onOpen: (url: string) => void;
}) {
	const Icon = props.icon;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
			onClick={() => props.onOpen(props.url)}
		>
			<Icon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="truncate">{props.label}</span>
			<ExternalLink className="ml-auto size-3 shrink-0 opacity-50" aria-hidden="true" />
		</Button>
	);
}

/**
 * 关于面板中的单行动作按钮：与 AboutLinkRow 同观感，但末尾是 chevron 而非外链箭头。
 * 语义区别：AboutLinkRow 会离开应用（系统浏览器），本行只打开应用内弹窗——
 * 用外链箭头会误导用户以为要跳走。
 */
function AboutActionRow(props: {
	icon: typeof Globe;
	label: string;
	onClick: () => void;
}) {
	const Icon = props.icon;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
			onClick={props.onClick}
		>
			<Icon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="truncate">{props.label}</span>
			<ChevronRight className="ml-auto size-3 shrink-0 opacity-50" aria-hidden="true" />
		</Button>
	);
}