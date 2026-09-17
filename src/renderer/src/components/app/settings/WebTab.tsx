import { memo, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { RotateCw } from "lucide-react";
import type { AppSettings, WebNetworkAddress, WebServiceStatusInfo } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingSwitchRow } from "./SettingRows";
import { cn } from "../../../lib/utils";

type WebTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  webServiceChanging: boolean;
  onOpenWebService: (port: string) => void;
  onRestartWebService: () => void;
  /** 壳层「取消」递增；本 tab 借此重置端口草稿等局部编辑态 */
  resetKey: number;
};

/**
 * 设置弹框「局域网 Web 服务」tab：原为开发设置内的区块，独立成 tab 便于高频访问。
 * 端口草稿/网卡列表/二维码等局部状态自持，只有进入本 tab 才加载；
 * 服务开关、端口、地址仍写入全局设置草稿，由弹框统一提交。
 */
export const WebTab = memo(function WebTab(props: WebTabProps) {
  const { draft, updateDraft } = props;

  // ── Web 服务端口/网卡/二维码（只在本 tab 展示）──
  const [webPortDraft, setWebPortDraft] = useState(String(draft.webServicePort));
  const [webNetworkAddresses, setWebNetworkAddresses] = useState<WebNetworkAddress[]>([]);
  const [selectedWebAddress, setSelectedWebAddress] = useState("");
  const [webQrDataUrl, setWebQrDataUrl] = useState("");
  const [webNetworkLoading, setWebNetworkLoading] = useState(false);
  const [webStatus, setWebStatus] = useState<WebServiceStatusInfo | null>(null);

  const applyWebPortDraft = () => {
    const port = Number(webPortDraft);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== draft.webServicePort) {
      updateDraft({ webServicePort: port });
    } else {
      setWebPortDraft(String(draft.webServicePort));
    }
  };

  // 网卡地址只在设置弹框内展示；优先局域网 IPv4，VPN/虚拟网卡仍保留为可选入口。
  useEffect(() => {
    const loadAddresses = desktopApi.app.networkAddresses;
    if (typeof loadAddresses !== "function") return;
    let active = true;
    setWebNetworkLoading(true);
    void loadAddresses()
      .then((addresses) => {
        if (!active) return;
        setWebNetworkAddresses(addresses);
        setSelectedWebAddress((current) =>
          addresses.some((item) => item.address === current)
            ? current
            : addresses.find((item) => item.isPrivate)?.address ?? addresses[0]?.address ?? "",
        );
      })
      .catch(() => {
        if (active) setWebNetworkAddresses([]);
      })
      .finally(() => {
        if (active) setWebNetworkLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // 服务开启时读取运行状态（含本次启动的令牌）；关闭/失败时清空，二维码回落为不带令牌。
  // 重启会重生成令牌（任务 2/3），故把 webServiceChanging 纳入刷新依赖：重启的 finally 置 false
  // 只发生在重启 IPC 成功之后，此刻重拉状态即拿到新令牌，避免二维码带过期令牌（裁决 C2）。
  const refreshWebStatus = useCallback(() => {
    if (!draft.webServiceEnabled) {
      setWebStatus(null);
      return;
    }
    void desktopApi.settings
      .webServiceStatus()
      .then((status) => setWebStatus(status))
      .catch(() => setWebStatus(null));
  }, [draft.webServiceEnabled]);

  useEffect(() => {
    refreshWebStatus();
  }, [refreshWebStatus, webPortDraft, selectedWebAddress, props.webServiceChanging]);

  // 局域网绑定时二维码附带启动时随机生成的访问令牌；环回绑定不需要令牌。
  const tokenSuffix =
    webStatus?.running && webStatus.requiresAuth && webStatus.token
      ? `?token=${encodeURIComponent(webStatus.token)}`
      : "";
  const webAccessUrl = selectedWebAddress
    ? `http://${selectedWebAddress}:${webPortDraft || draft.webServicePort}${tokenSuffix}`
    : "";

  // URL 或开关变化时重新编码，二维码只保存 data URL，不把主进程能力暴露给页面。
  useEffect(() => {
    if (!draft.webServiceEnabled || !webAccessUrl) {
      setWebQrDataUrl("");
      return;
    }
    let active = true;
    void QRCode.toDataURL(webAccessUrl, {
      width: 192,
      margin: 1,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (active) setWebQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setWebQrDataUrl("");
      });
    return () => {
      active = false;
    };
  }, [draft.webServiceEnabled, webAccessUrl]);

  // 壳层「取消」：重置本 tab 局部编辑态（Web 端口草稿）
  useEffect(() => {
    setWebPortDraft(String(draft.webServicePort));
  }, [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SettingsSection title={t("settings.webLocalService")} description={t("settings.webLocalServiceDesc")}>
      <SettingSwitchRow
        anchor="web-enable-service"
        title={t("settings.enableWebService")}
        description={
          props.webServiceChanging
            ? t("settings.webOpening")
            : t("settings.webOffDesc")
        }
        checked={draft.webServiceEnabled}
        disabled={props.webServiceChanging}
        onChange={(checked) =>
          updateDraft({ webServiceEnabled: checked })
        }
      />
      <div className="mt-2.5 grid gap-2.5">
        {/* Web 服务地址：主机（只读）+ 端口（可编辑）；shadcn Input + Label，
            两列均分不再有主机列挤压/过宽问题，主机超长时 Input 内滚动 */}
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <Label className="text-xs font-bold text-text-tertiary">{t("common.host")}</Label>
            <Input
              value={draft.webServiceHost}
              readOnly
              className="mt-1 font-mono text-sm tabular-nums"
            />
          </div>
          <div className="min-w-0">
            <Label className="text-xs font-bold text-text-tertiary">{t("common.port")}</Label>
            <Input
              type="number"
              min={1}
              max={65535}
              value={webPortDraft}
              disabled={props.webServiceChanging}
              className="mt-1 font-mono text-sm tabular-nums"
              onChange={(event) => setWebPortDraft(event.target.value)}
              onBlur={applyWebPortDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyWebPortDraft();
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-border-subtle/70 bg-bg-muted/30 px-3 py-2.5">
          {/* 服务状态点：开启时 accent 色 + 光晕，关闭时灰 */}
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              draft.webServiceEnabled
                ? "bg-[var(--color-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "bg-text-tertiary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-text-tertiary)_12%,transparent)]",
            )}
          />
          <div className="min-w-0">
            <strong className="block truncate text-caption font-semibold text-text-primary">
              http://127.0.0.1:{webPortDraft || draft.webServicePort}
            </strong>
            <small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.localWebHint")}</small>
          </div>
          <Button variant="secondary"
            size="sm"
            disabled={!draft.webServiceEnabled}
            onClick={() =>
              props.onOpenWebService(webPortDraft || String(draft.webServicePort))
            }
          >
            {t("common.open")}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!draft.webServiceEnabled || props.webServiceChanging}
            onClick={props.onRestartWebService}
          >
            <RotateCw className="mr-1.5 size-3.5" aria-hidden="true" />
            {props.webServiceChanging ? t("settings.webRestarting") : t("settings.webRestartService")}
          </Button>
        </div>
        <div className="grid gap-2 rounded-lg border border-border-subtle/70 bg-bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <strong className="block text-caption font-semibold text-text-primary">{t("settings.webQrTitle")}</strong>
              <small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.webQrDesc")}</small>
            </div>
            {webNetworkLoading && <span className="text-micro text-text-tertiary">{t("settings.webNetworkLoading")}</span>}
          </div>
          {webNetworkAddresses.length > 0 ? (
            <div className="grid gap-1.5">
              <Label className="text-xs font-bold text-text-tertiary">{t("settings.webQrAddress")}</Label>
              <Select value={selectedWebAddress} onValueChange={setSelectedWebAddress}>
                <SelectTrigger className="font-mono text-sm tabular-nums">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {webNetworkAddresses.map((item) => (
                    <SelectItem key={item.address} value={item.address}>
                      <span className="font-mono">{item.address}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{item.interfaceName}{item.cidr ? ` · /${item.cidr.split("/")[1]}` : ""}{item.isPrivate ? ` · ${t("settings.webLanAddress")}` : ""}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-caption text-text-tertiary">{t("settings.webNoNetworkAddress")}</p>
          )}
          {webQrDataUrl ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <img src={webQrDataUrl} alt={t("settings.webQrAlt")} className="size-44 rounded-md bg-white p-2" />
              <div className="min-w-0 flex-1">
                <code className="block break-all text-caption text-text-primary">{webAccessUrl}</code>
                <small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrScanHint")}</small>
                {webStatus?.running && webStatus.requiresAuth ? (
                  <small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrTokenHint")}</small>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-caption text-text-tertiary">{draft.webServiceEnabled ? t("settings.webQrUnavailable") : t("settings.webQrEnableHint")}</p>
          )}
        </div>
      </div>
    </SettingsSection>
  );
});