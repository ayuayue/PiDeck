/**
 * 会话代理设置弹框（侧栏会话右键菜单 → 会话代理）
 *
 * 单会话开关模型（用户确认的方案）：每会话三选一
 * - follow：跟随全局代理设置（缺省）；
 * - on：强制启用代理，URL 复用全局 piProxyUrl（全局开关关闭时也生效）；
 * - off：强制直连（全局开着代理时本会话也不走）。
 * 持久化到 SessionRecord.proxy（catalog 可选字段，重启保留；旧数据缺省 follow）。
 *
 * 生效边界（与主进程链路一致，展示给用户避免误解）：
 * - pi 会话：设置应用于该会话的 pi 子进程 spawn env，改后需重启会话 runtime；
 * - DSH 会话：DSH 是单一共享 host（无 per-session 通道），设置聚合到 host fork env
 *   （off 优先于 on），需 host 重启后生效；host 的 LLM 请求经 globalThis.fetch（undici），
 *   PiDeck 同时注入 NODE_USE_ENV_PROXY=1 使其真正读取代理环境变量（Node 22.21+ 行为）。
 */
import { useEffect, useState } from "react";
import { Check, Globe, PlugZap, Unplug } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { sessionRecordByIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import type { SessionProxyMode } from "../../../../shared/types/session";

const PROXY_OPTIONS: Array<{
  id: SessionProxyMode;
  icon: typeof Globe;
  labelKey: "sessionProxy.follow" | "sessionProxy.on" | "sessionProxy.off";
  descKey: "sessionProxy.followDesc" | "sessionProxy.onDesc" | "sessionProxy.offDesc";
}> = [
  { id: "follow", icon: Globe, labelKey: "sessionProxy.follow", descKey: "sessionProxy.followDesc" },
  { id: "on", icon: PlugZap, labelKey: "sessionProxy.on", descKey: "sessionProxy.onDesc" },
  { id: "off", icon: Unplug, labelKey: "sessionProxy.off", descKey: "sessionProxy.offDesc" },
];

export function SessionProxyDialog(props: { sessionId: string; onClose: () => void }) {
  const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
  const upsertSession = useSetAtom(upsertSessionAtom);
  const [saving, setSaving] = useState(false);
  const [globalProxy, setGlobalProxy] = useState<{ enabled: boolean; url: string; providers: string[] } | null>(null);

  // 当前生效模式：会话记录覆盖 > 跟随全局（缺省）
  const currentMode: SessionProxyMode = record?.proxy?.mode ?? "follow";
  const isDsh = record?.backend === "dsh";
  const provider = record?.model?.provider;

  useEffect(() => {
    let cancelled = false;
    // 打开时拉一次全局代理状态，用于展示「启用代理」时的地址来源与空地址告警
    void desktopApi.settings.get().then((settings) => {
      if (cancelled) return;
      setGlobalProxy({ enabled: settings.piProxyEnabled, url: settings.piProxyUrl, providers: settings.piProxyProviders ?? [] });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (mode: SessionProxyMode) => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await desktopApi.sessions.updateRecord(props.sessionId, { proxy: { mode } });
      upsertSession(updated);
      showNotice(isDsh ? t("sessionProxy.dshSavedNotice") : t("sessionProxy.savedNotice"), 3000);
      props.onClose();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
      setSaving(false);
    }
  };

  const globalUrlEmpty = globalProxy !== null && !globalProxy.url.trim();

  return (
    <Dialog open onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(560px,calc(100vh-48px))] w-[min(420px,calc(100vw-48px))] flex-col gap-0 p-0"
      >
        {/* 头部 */}
        <div className="flex flex-col gap-1 border-b border-border/60 px-4 py-3">
          <h2 className="text-control font-semibold text-foreground">{t("sessionProxy.title")}</h2>
          <p className="text-micro text-muted-foreground/80">{t("sessionProxy.manageHint")}</p>
        </div>

        {/* 三选一开关 */}
        <div className="flex flex-col gap-1 px-2 py-2">
          {PROXY_OPTIONS.map((option) => {
            const selected = currentMode === option.id;
            const Icon = option.icon;
            return (
              <Button
                key={option.id}
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void save(option.id)}
                className="flex h-auto min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-muted/60"
              >
                <span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-control font-semibold text-foreground">{t(option.labelKey)}</span>
                  <span className="block text-micro text-muted-foreground/75">{t(option.descKey)}</span>
                </span>
                {selected ? <Check size={15} className="shrink-0 text-primary" aria-hidden="true" /> : null}
              </Button>
            );
          })}
        </div>

        {/* 全局代理状态 + 生效边界提示 */}
        <div className="flex flex-col gap-1.5 border-t border-border/60 px-4 py-3 text-micro text-muted-foreground/80">
          <p>
            {t("sessionProxy.globalStatus", {
              status: globalProxy === null
                ? "…"
                : globalProxy.enabled
                  ? t("sessionProxy.globalOn", { url: globalProxy.url })
                  : t("sessionProxy.globalOff"),
            })}
          </p>
          {globalUrlEmpty && (
            <p className="text-warning">{t("sessionProxy.globalEmptyWarn")}</p>
          )}
          {/* 按供应商过滤的生效提示：仅当 follow 时才会被白名单覆盖，显式 on/off 最高优 */}
          {globalProxy && globalProxy.providers.length > 0 && currentMode === "follow" && provider && (
            globalProxy.providers.includes(provider)
              ? <p className="text-primary/80">{t("sessionProxy.providerFilterMatched", { provider })}</p>
              : <p>{t("sessionProxy.providerFilterNotMatched", { provider })}</p>
          )}
          {globalProxy && globalProxy.providers.length > 0 && (
            <p className="text-muted-foreground/60">{t("sessionProxy.providerFilterHint")}</p>
          )}
          {isDsh && <p className="text-muted-foreground/70">{t("sessionProxy.dshShareHint")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}