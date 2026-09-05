import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, AvailableModel } from "../../../../../shared/types";
import { CheckCheck, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, RefreshCw, Search } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";
import { desktopApi } from "../../../desktopApi";
// 分组折叠复用模型选择器同一套机制：groupModelsByProvider 按提供商分组 +
// commandPickerExpansion 的「派生默认展开 + 用户覆盖」纯状态机（搜索激活时强制展开）。
import { groupModelsByProvider } from "../../session/sessionPickerOptions";
import {
	INITIAL_PICKER_GROUP_SELECTION,
	applyPickerGroupAction,
	resolveGroupExpanded,
	type PickerGroupSelection,
} from "../../ui-shadcn/commandPickerExpansion";

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
  "piProxyEnabled",
  "piProxyUrl",
  "piProxyBypass",
  "piProxyModels",
  "desktopProxyEnabled",
  "desktopProxyUrl",
  "desktopProxyBypass",
];

type ProxyTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  piProxyChecking: boolean;
  piProxyNotice: string;
  piProxyNoticeTone: "info" | "success" | "error";
  onTestPiProxy: () => void;
};

/**
 * 设置弹框「代理设置」tab：pi / 桌面代理两段（未保存变更提示 + 统一保存/取消）。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 * 「按模型走代理」用模型表格（与 Pi 管理 → 模型 同款 Table 展示），搜索按 provider/ID/名称过滤。
 */
export const ProxyTab = memo(function ProxyTab(props: ProxyTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // 模型名单的批量勾选已有组内/顶部已选数和全局保存栏反馈；首次选择时再插入
  // 局部横幅会改变滚动内容高度并造成视口跳动。因此横幅仅用于其余代理配置字段。
  const proxyBannerDirty = PROXY_FIELDS.some(
    (field) => field !== "piProxyModels" && isDirty(field),
  );
  // 模型白名单候选：从 models.json 拉全量（与会话模型选择器同一数据源），保留 AvailableModel 结构，
  // 搜索可同时命中 provider/modelId 与显示名。
  const [availableModelList, setAvailableModelList] = useState<AvailableModel[] | null>(null);
  // models.json 里配置的供应商名（独立于模型条目）：供应商只建了名字还没加模型时，
  // pi --list-models 不会输出它 → 白名单候选里完全看不到，用户以为刷新丢了供应商。
  // 这里单独读出并展示为「无模型供应商」小节，点击可跳转到 Pi 管理 → 模型 补模型。
  const [configProviderNames, setConfigProviderNames] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [proxyListLoading, setProxyListLoading] = useState(false);
  // 手动刷新：绕过缓存重新 fork pi --list-models（白名单候选加载不出来时重试）。
  const [proxyListRefreshing, setProxyListRefreshing] = useState(false);
  const refreshModelCandidates = useCallback(async (force = false) => {
    if (force) setProxyListRefreshing(true);
    else setProxyListLoading(true);
    try {
      // 候选模型与供应商名单并行拉取；两边都失败也不阻塞，回落空列表。
      const [report, configResult] = await Promise.all([
        desktopApi.projects.listModelsReport(undefined, force),
        desktopApi.config.getModels().catch(() => null),
      ]);
      // 无 provider 的模型无法参与 provider/modelId 匹配（策略层直接跳过），不进名单候选。
      setAvailableModelList(report.models.filter((m) => m.provider && m.id));
      setConfigProviderNames(
        configResult?.parsed
          ? Object.keys(configResult.parsed.providers ?? {}).sort((a, b) => a.localeCompare(b))
          : [],
      );
    } catch {
      setAvailableModelList([]);
    } finally {
      setProxyListLoading(false);
      setProxyListRefreshing(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    setProxyListLoading(true);
    void Promise.all([
      desktopApi.projects.listModels(undefined),
      desktopApi.config.getModels().catch(() => null),
    ]).then(([models, configResult]) => {
      if (cancelled) return;
      // 无 provider 的模型无法参与 provider/modelId 匹配（策略层直接跳过），不进名单候选。
      setAvailableModelList(models.filter((m) => m.provider && m.id));
      setConfigProviderNames(
        configResult?.parsed
          ? Object.keys(configResult.parsed.providers ?? {}).sort((a, b) => a.localeCompare(b))
          : [],
      );
    }).catch(() => {
      if (!cancelled) setAvailableModelList([]);
    }).finally(() => {
      if (!cancelled) setProxyListLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  const selectedModels = useMemo(() => new Set(draft.piProxyModels ?? []), [draft.piProxyModels]);
  const availableModelKeys = useMemo(
    () => new Set((availableModelList ?? []).map((m) => `${m.provider}/${m.id}`)),
    [availableModelList],
  );
  // 已选但不在当前 models.json 的条目（可能已删模型/改名），单独小节展示可取消，防止坏值残留不可见。
  const extraModelKeys = useMemo(
    () => [...selectedModels].filter((key) => !availableModelKeys.has(key)).sort((a, b) => a.localeCompare(b)),
    [selectedModels, availableModelKeys],
  );
  const hasModelFilter = (draft.piProxyModels?.length ?? 0) > 0;
  // 搜索：本地即时过滤（provider/modelId 与显示名均可命中），仅影响显示，不影响已保存名单。
  const modelSearchQuery = modelSearch.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    const list = availableModelList ?? [];
    if (!modelSearchQuery) return list;
    return list.filter((m) => {
      const key = `${m.provider}/${m.id}`;
      return key.toLowerCase().includes(modelSearchQuery) || (m.name ?? "").toLowerCase().includes(modelSearchQuery);
    });
  }, [availableModelList, modelSearchQuery]);
  // 勾选/取消：provider/modelId 为原子条目，与策略层 resolveModelProxyMode 的匹配格式一致。
  const toggleModelKey = (key: string, checked: boolean) => {
    const nextSet = new Set(selectedModels);
    if (checked) nextSet.add(key);
    else nextSet.delete(key);
    updateDraft({ piProxyModels: [...nextSet] });
  };

  // —— 提供商分组折叠（复用模型选择器同一套机制）——
  // 默认展开只取进入设置时的已选快照。后续勾选/全选不应反向展开或收起正在操作的组，
  // 否则会改变列表高度并把用户的视口位置拉走；重新打开此 tab 时会按最新草稿重建默认值。
  const [initialSelectedModelKeys] = useState(() => [...(draft.piProxyModels ?? [])]);
  const [groupSelection, setGroupSelection] = useState<PickerGroupSelection>(() => INITIAL_PICKER_GROUP_SELECTION);
  const searchActive = modelSearchQuery.length > 0;
  const defaultExpandedGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of initialSelectedModelKeys) {
      const slash = key.indexOf("/");
      if (slash > 0) ids.add(`provider:${key.slice(0, slash)}`);
    }
    return ids;
  }, [initialSelectedModelKeys]);
  const groupedVisibleModels = useMemo(() => groupModelsByProvider(visibleModels), [visibleModels]);
  const visibleProviders = useMemo(
    () => Object.keys(groupedVisibleModels).sort((a, b) => a.localeCompare(b)),
    [groupedVisibleModels],
  );
  // models.json 里配置了名字、但还没有任何模型条目的供应商：pi --list-models 不会
  // 输出它们，若不单独展示，用户刷新后会误以为“代理配置检测不到新加的供应商”。
  const emptyProviderNames = useMemo(() => {
    const withModels = new Set(visibleProviders);
    const query = modelSearchQuery;
    return configProviderNames
      .filter((name) => {
        if (withModels.has(name)) return false;
        if (query && !name.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => a.localeCompare(b));
  }, [configProviderNames, visibleProviders, modelSearchQuery]);
  const toggleProviderGroup = useCallback((provider: string) => {
    setGroupSelection((current) =>
      applyPickerGroupAction({
        selection: current,
        defaultExpandedIds: defaultExpandedGroupIds,
        action: { kind: "toggle", groupId: `provider:${provider}` },
      }),
    );
  }, [defaultExpandedGroupIds]);
  const setAllProviderGroups = useCallback((action: "expandAll" | "collapseAll") => {
    setGroupSelection((current) =>
      applyPickerGroupAction({
        selection: current,
        defaultExpandedIds: defaultExpandedGroupIds,
        action: action === "expandAll" ? { kind: "expandAll" } : { kind: "collapseAll" },
      }),
    );
  }, [defaultExpandedGroupIds]);
  // 组内全选/取消全选：只操作当前提供商分组内的模型，组外已选（含 extras）不受影响。
  // 组内全部已选时按钮变为「取消全选」（切换语义，与 selectAll 类按钮惯例一致）。
  const toggleSelectAllInGroup = (models: AvailableModel[]) => {
    const keys = models.map((m) => `${m.provider}/${m.id}`);
    const allSelected = keys.every((key) => selectedModels.has(key));
    const nextSet = new Set(selectedModels);
    for (const key of keys) {
      if (allSelected) nextSet.delete(key);
      else nextSet.add(key);
    }
    updateDraft({ piProxyModels: [...nextSet] });
  };
  /** extras 的紧凑勾选行（无供应商/名称列，整串 key 展示）。 */
  const renderExtraRow = (key: string) => {
    const checked = selectedModels.has(key);
    return (
      <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-control hover:bg-muted/40">
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => toggleModelKey(key, next === true)}
        />
        <span className="min-w-0 truncate font-mono text-caption" title={key}>{key}</span>
      </label>
    );
  };

  return (
    <>
      {/* 未保存更改的提示横幅 */}
      {proxyBannerDirty && (
        <div className="setting-proxy-unsaved-bar">
          <span className="setting-proxy-unsaved-dot" />
          <span>{t("settings.proxyUnsaved")}</span>
          <small>{t("settings.proxyApplyHint")}</small>
        </div>
      )}
      <SettingsSection
        title={t("settings.piProxy")}
        description={t("settings.piProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enablePiProxy")}
          description={t("settings.enablePiProxyDesc")}
          checked={draft.piProxyEnabled}
          onChange={(checked) =>
            updateDraft({ piProxyEnabled: checked })
          }
        />
        {/* 配置与开关解耦：地址/绕过/测试始终可编辑，关闭开关时仅保存配置不启用——
            单会话「会话代理」的 on 模式会复用下方地址，无需全局开启。 */}
        <div className="setting-proxy-panel">
          <SettingRow
            title={<span>{t("settings.proxyUrl")}</span>}
            stacked
          >
            <Input type="text" value={draft.piProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ piProxyUrl: event.target.value })} />
          </SettingRow>
          <SettingRow
            title={<span>{t("settings.proxyBypass")}</span>}
            description={t("settings.noProxyHint")}
            stacked
          >
            <Input type="text" value={draft.piProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ piProxyBypass: event.target.value })} />
          </SettingRow>
          <SettingRow
            title={<span>{t("settings.proxyTest")}</span>}
            description={
              <>
                {t("settings.proxyNoApiKey")}
                {props.piProxyNotice && (
                  <span className={`setting-status ${props.piProxyNoticeTone}`}>
                    {props.piProxyNotice}
                  </span>
                )}
              </>
            }
          >
            <Button variant="secondary"
              onClick={props.onTestPiProxy}
              disabled={props.piProxyChecking}
            >
              {props.piProxyChecking
                ? t("settings.testingProxy")
                : t("settings.testProxy")}
            </Button>
          </SettingRow>
          {/* 按模型走代理：名单内模型强制走代理（即使全局关闭也复用上方地址），名单外强制直连；
              留空则跟随全局/会话设置。模型表格与 Pi 管理 → 模型 同款展示，搜索按任意列过滤。 */}
          <SettingRow
            title={<span>{t("settings.piProxyModels")}</span>}
            description={t("settings.piProxyModelsDesc")}
            stacked
          >
            <div className="flex flex-col gap-2.5">
              {/* 顶部操作行：搜索 + 已选计数 + 清空（结构对齐 Pi 管理模型列表头部） */}
              <div className="flex flex-nowrap items-center gap-2 max-[820px]:flex-wrap">
                <div className="relative min-w-0 flex-1 basis-52">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
                  <Input
                    type="text"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder={t("settings.piProxyModelsSearch")}
                    className="h-8 pl-8 text-control"
                    disabled={proxyListLoading}
                  />
                </div>
                {/* 刷新候选列表：绕过缓存重新拉取模型列表（与会话模型选择器刷新按钮同源能力） */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t("app.modelPickerRefresh")}
                  title={proxyListRefreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
                  disabled={proxyListRefreshing || proxyListLoading}
                  onClick={() => void refreshModelCandidates(true)}
                >
                  <RefreshCw size={14} className={proxyListRefreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
                </Button>
                {/* 展开/折叠所有提供商分组：与模型选择器头部按钮同源能力 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t("app.modelExpandAllProviders")}
                  title={t("app.modelExpandAllProviders")}
                  disabled={proxyListLoading}
                  onClick={() => setAllProviderGroups("expandAll")}
                >
                  <ChevronsUpDown size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t("app.modelCollapseAllProviders")}
                  title={t("app.modelCollapseAllProviders")}
                  disabled={proxyListLoading}
                  onClick={() => setAllProviderGroups("collapseAll")}
                >
                  <ChevronsDownUp size={14} aria-hidden="true" />
                </Button>
                <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-micro text-muted-foreground/80">
                  {hasModelFilter ? (
                    <span>{t("settings.piProxyModelsSelected", { count: selectedModels.size })}</span>
                  ) : (
                    <span>{t("settings.piProxyModelsAllFollow")}</span>
                  )}
                  {hasModelFilter && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-micro"
                      onClick={() => updateDraft({ piProxyModels: [] })}
                    >
                      {t("settings.piProxyModelsClear")}
                    </Button>
                  )}
                </div>
              </div>
              {/* 已选但不在当前列表的模型（可能已删/改名）：独立小节防止坏值残留不可见 */}
              {extraModelKeys.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="px-0.5 text-micro font-medium text-muted-foreground">{t("settings.piProxyModelsExtras")}</span>
                  <div className="flex flex-col gap-1 rounded-md border border-amber-500/25 bg-amber-500/5 p-2">
                    {extraModelKeys.map(renderExtraRow)}
                  </div>
                </div>
              )}
              {/* 只加了供应商名、还没加模型的供应商：pi --list-models 不会出现它们，
                  这里单独列出提醒用户去 Pi 管理 → 模型 补模型（代理策略按 provider/modelId 匹配，没有模型无从配置） */}
              {emptyProviderNames.length > 0 && !proxyListLoading && (
                <div className="flex flex-col gap-1">
                  <span className="px-0.5 text-micro font-medium text-muted-foreground">{t("settings.piProxyModelsNoModelProviders")}</span>
                  <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/20 p-2">
                    {emptyProviderNames.map((providerName) => (
                      <div key={providerName} className="flex min-w-0 items-baseline gap-2 px-2 py-0.5">
                        <span className="min-w-0 flex-none font-mono text-caption text-foreground" title={providerName}>{providerName}</span>
                        <span className="min-w-0 truncate text-micro text-muted-foreground/80">{t("settings.piProxyModelsNoModelHint")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {proxyListLoading ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyModelsLoading")}</span>
              ) : visibleModels.length === 0 ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyModelsEmpty")}</span>
              ) : (
                <div className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-popover/40">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-10" />
                        <TableHead className="min-w-0">{t("config.modelId")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleProviders.map((provider) => {
                        const groupId = `provider:${provider}`;
                        const models = groupedVisibleModels[provider];
                        const selectedInGroup = models.filter((m) => selectedModels.has(`${m.provider}/${m.id}`)).length;
                        const allSelected = selectedInGroup === models.length && models.length > 0;
                        const expanded = resolveGroupExpanded({
                          selection: groupSelection,
                          defaultExpandedIds: defaultExpandedGroupIds,
                          searchActive,
                          groupId,
                        });
                        return (
                          <Fragment key={provider}>
                            {/* 提供商分组头：点击折叠/展开（搜索激活时强制展开，点击记录覆盖、清空搜索后生效） */}
                            <TableRow data-proxy-model-provider={provider} className="p-0 hover:bg-transparent">
                              <TableCell colSpan={2} className="p-0">
                                {/* 组头 = 折叠切换区 + 全选按钮（button 不能嵌套 button，故拆为两个平级按钮） */}
                                <div className="flex items-center gap-1 pr-1.5">
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                    aria-expanded={expanded}
                                    onClick={() => toggleProviderGroup(provider)}
                                  >
                                    {expanded
                                      ? <ChevronDown className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                                      : <ChevronRight className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />}
                                    <span className="max-w-[45%] flex-none truncate font-mono text-caption font-medium text-foreground">{provider}</span>
                                    <span className="flex-none whitespace-nowrap font-mono text-caption text-muted-foreground/70">
                                      {t("config.count.models", { count: models.length })}
                                    </span>
                                    {/* 固定预留已选计数宽度，首次选择时组头不会因插入文字而重排。 */}
                                    <span className="min-w-4 flex-1" />
                                    <span
                                      className={`min-w-20 flex-none whitespace-nowrap text-right text-micro font-medium text-amber-600/90 dark:text-amber-400/90 ${selectedInGroup === 0 ? "invisible" : ""}`}
                                      aria-hidden={selectedInGroup === 0}
                                    >
                                      {t("settings.piProxyModelsGroupSelected", { count: selectedInGroup })}
                                    </span>
                                  </button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-24 shrink-0 gap-1 px-2 text-micro text-muted-foreground hover:text-foreground"
                                    aria-label={allSelected ? t("common.deselectAll") : t("common.selectAll")}
                                    title={allSelected ? t("common.deselectAll") : t("common.selectAll")}
                                    onClick={() => toggleSelectAllInGroup(models)}
                                  >
                                    <CheckCheck size={13} aria-hidden="true" />
                                    {allSelected ? t("common.deselectAll") : t("common.selectAll")}
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                            {expanded && models.map((m) => {
                              const key = `${m.provider}/${m.id}`;
                              const checked = selectedModels.has(key);
                              return (
                                // 整行可点击切换；勾选列拦截冒泡避免 checkbox 触发两次（onChange + row onClick）。
                                <TableRow
                                  key={key}
                                  className="cursor-pointer"
                                  onClick={() => toggleModelKey(key, !checked)}
                                >
                                  <TableCell className="w-10 p-2 pl-3" onClick={(event) => event.stopPropagation()}>
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(next) => toggleModelKey(key, next === true)}
                                      aria-label={key}
                                    />
                                  </TableCell>
                                  <TableCell className="p-2 font-mono text-caption text-foreground" title={key}>{m.id}</TableCell>
                                </TableRow>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {modelSearchQuery && visibleModels.length > 0 && (
                <span className="text-micro text-muted-foreground/70">{t("settings.piProxyModelsSearchHint")}</span>
              )}
              <span className="text-micro text-muted-foreground/70">{t("settings.piProxyModelsHint")}</span>
            </div>
          </SettingRow>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("settings.desktopProxy")}
        description={t("settings.desktopProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enableDesktopProxy")}
          description={t("settings.desktopProxyDesc")}
          checked={draft.desktopProxyEnabled}
          onChange={(checked) =>
            updateDraft({ desktopProxyEnabled: checked })
          }
        />
        {draft.desktopProxyEnabled && (
          <div className="setting-proxy-panel">
            <SettingRow
              title={<span>{t("settings.proxyUrl")}</span>}
              stacked
            >
              <Input type="text" value={draft.desktopProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ desktopProxyUrl: event.target.value })} />
            </SettingRow>
            <SettingRow
              title={<span>{t("settings.proxyBypass")}</span>}
              description={t("settings.electronProxyHint")}
              stacked
            >
              <Input type="text" value={draft.desktopProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ desktopProxyBypass: event.target.value })} />
            </SettingRow>
          </div>
        )}
      </SettingsSection>
      {/* 代理变更走全局草稿：顶部统一保存/取消，不再在 tab 底部重复放按钮 */}
    </>
  );
});