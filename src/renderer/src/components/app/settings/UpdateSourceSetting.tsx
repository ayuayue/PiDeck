import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  MirrorHealthResult,
  UpdateSourceId,
} from "../../../../../shared/types/settings";
import {
  UPDATE_SOURCE_MIRRORS,
  buildCustomSourceFeedUrl,
  normalizeCustomMirrorHost,
} from "../../../../../shared/updateSources";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
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
export function UpdateSourceSetting(props: {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
}) {
  const { draft, updateDraft } = props;
  const source: UpdateSourceId = draft.updateSource ?? "github";
  const [customInput, setCustomInput] = useState(draft.customUpdateSourceUrl ?? "");

  // 镜像体检结果（按镜像 id 索引；null 表示尚未完成首次探测）
  const [mirrorHealth, setMirrorHealth] = useState<Record<string, MirrorHealthResult> | null>(null);
  const [probing, setProbing] = useState(false);

  // 实时规范化自定义前缀：非法/为空返回 null（UI 提示用）；纯派生值用 memo 避免重复计算。
  const normalizedCustomHost = useMemo(
    () => normalizeCustomMirrorHost(customInput),
    [customInput],
  );

  // 当前生效的更新源地址（github = null → 内置官方通道）；custom 非法时降级显示官方。
  const activeFeedUrl: string | null = (() => {
    if (source === "github") return null;
    if (source === "custom") {
      return normalizedCustomHost ? buildCustomSourceFeedUrl(normalizedCustomHost) : null;
    }
    const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
    return mirror ? buildCustomSourceFeedUrl(mirror.host) : null;
  })();

  // 并行体检所有内置镜像；期间锁定 probing，防止重复触发（重新检测按钮也走同一入口）。
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

  // 镜像状态点渲染；未探测/探测中显示灰色占位，避免下拉项宽度跳动
  const healthDot = (id: string) => {
    const h = mirrorHealth?.[id];
    if (!h) return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
    return <span className={`size-1.5 rounded-full ${HEALTH_DOT_CLASS[h.status]}`} />;
  };

  // 镜像行右侧的实测速度/延迟文本（broken 时显示原因）
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
          // 描述区直接展示当前生效的完整 feed URL，镜像与自定义一眼可见拼接结果
          activeFeedUrl
            ? t("settings.updateSourceFeedPreview", { url: activeFeedUrl })
            : t("settings.updateSourceFeedOfficial")
        }
      >
        <Select
          value={source}
          onValueChange={(value) => updateDraft({ updateSource: value as UpdateSourceId })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="github">{t("settings.updateSourceGithub")}</SelectItem>
            {UPDATE_SOURCE_MIRRORS.map((mirror) => (
              <SelectItem key={mirror.id} value={mirror.id}>
                <span className="flex items-center gap-2">
                  {healthDot(mirror.id)}
                  <span>{mirror.host}</span>
                  {healthText(mirror.id) && (
                    <span className="text-muted-foreground">{healthText(mirror.id)}</span>
                  )}
                </span>
              </SelectItem>
            ))}
            <SelectItem value="custom">{t("settings.updateSourceCustom")}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {source === "custom" && (
        <SettingRow
          stacked
          title={t("settings.updateSourceCustomHint")}
          description={
            normalizedCustomHost
              ? t("settings.updateSourceFeedPreview", {
                  url: buildCustomSourceFeedUrl(normalizedCustomHost),
                })
              : customInput.trim()
                ? t("settings.updateSourceCustomInvalid")
                : undefined
          }
        >
          <Input
            value={customInput}
            placeholder="https://ghfast.top"
            onChange={(event) => {
              setCustomInput(event.target.value);
              updateDraft({ customUpdateSourceUrl: event.target.value });
            }}
          />
        </SettingRow>
      )}

      {/* 体检状态栏：仅镜像源展示；github 官方链路与自定义源不参与内置镜像探测 */}
      {source !== "github" && source !== "custom" && (() => {
        const text = mirrorHealth?.[source] ? healthText(source) : null;
        return (
          <div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              {healthDot(source)}
              {probing || !text ? t("settings.updateMirrorChecking") : text}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={probing}
              onClick={() => void probeMirrors()}
            >
              {t("settings.updateMirrorRetest")}
            </Button>
          </div>
        );
      })()}
    </>
  );
}