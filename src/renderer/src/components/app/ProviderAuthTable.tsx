import { useMemo, useState } from "react";
import { ExternalLink, KeyRound, LogOut, RefreshCw, Search } from "lucide-react";
import type { PiAuthMethod, PiAuthProviderOption } from "../../../../shared/types/piAuth";
import { t } from "../../i18n";
import { describeAuthProviderRow, filterAuthProviders } from "../../utils/providerLoginList";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui-shadcn/table";

type ProviderAuthTableProps = {
	providers: PiAuthProviderOption[];
	/** 有登录/登出正在进行：整表按钮禁用，避免并发操作把 pi 的凭据写乱。 */
	busyProviderId?: string;
	piVersion?: string;
	onStartLogin: (providerId: string, method: PiAuthMethod) => void;
	onLogout: (providerId: string) => void;
	onRefresh: () => void;
};

/**
 * 可登录供应商的 data table。
 *
 * 用表格而不是卡片堆叠：列表项字段完全同构（名称/id/登录方式/状态/操作），
 * 表格能对齐列、容纳更多行，也避免卡片里「状态」孤零零飘在右上角。
 * 过滤与行状态规则在 `utils/providerLoginList.ts`（纯函数，可单测）。
 */
export function ProviderAuthTable({ providers, busyProviderId, piVersion, onStartLogin, onLogout, onRefresh }: ProviderAuthTableProps) {
	const [query, setQuery] = useState("");
	const visible = useMemo(() => filterAuthProviders(providers, query), [providers, query]);
	const busy = busyProviderId !== undefined;

	return (
		<div className="flex min-h-0 flex-col gap-2">
			{/* 搜索栏随内容滚动会跟着跑掉（列表 40+ 行），钉在顶部才不会每翻一页就往上找。 */}
			<div className="sticky top-0 z-10 flex items-center gap-2 bg-background pb-1">
				{/* 内置供应商有 40+ 项，搜索是必需品；匹配 id/名称/登录方式标签。 */}
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input className="pl-7" placeholder={t("providerLogin.search.placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
				</div>
				{piVersion && <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("providerLogin.piVersion", { version: piVersion })}</span>}
				<Button size="icon" variant="ghost" title={t("providerLogin.refresh")} aria-label={t("providerLogin.refresh")} onClick={onRefresh}>
					<RefreshCw className="size-3.5" />
				</Button>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[42%]">{t("providerLogin.col.provider")}</TableHead>
						<TableHead>{t("providerLogin.col.method")}</TableHead>
						<TableHead className="w-28 text-right">{t("providerLogin.col.actions")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{visible.length === 0 && (
						<TableRow>
							<TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
								{providers.length === 0 ? t("providerLogin.noProviders") : t("providerLogin.search.empty", { query: query.trim() })}
							</TableCell>
						</TableRow>
					)}
					{visible.map((provider) => (
						<ProviderRow key={provider.id} provider={provider} disabled={busy} active={busyProviderId === provider.id} onStartLogin={onStartLogin} onLogout={onLogout} />
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ProviderRow({ provider, disabled, active, onStartLogin, onLogout }: { provider: PiAuthProviderOption; disabled: boolean; active: boolean; onStartLogin: (providerId: string, method: PiAuthMethod) => void; onLogout: (providerId: string) => void }) {
	const row = describeAuthProviderRow(provider);
	return (
		<TableRow>
			<TableCell className="align-top">
				<div className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 truncate font-medium">{provider.name || provider.id}</span>
					<Badge variant={row.loggedIn ? "secondary" : "outline"}>{row.loggedIn ? t("providerLogin.status.loggedIn") : t("providerLogin.status.loggedOut")}</Badge>
				</div>
				<div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex flex-wrap items-center gap-2">
					{provider.oauth && (
						<Button size="sm" variant="outline" disabled={disabled} title={provider.oauth.label} onClick={() => onStartLogin(provider.id, "oauth")}>
							<ExternalLink className="size-3.5" />
							{provider.oauth.label || t("providerLogin.method.oauth")}
						</Button>
					)}
					{provider.apiKey?.canLogin && (
						<Button size="sm" variant="outline" disabled={disabled} title={provider.apiKey.name} onClick={() => onStartLogin(provider.id, "api_key")}>
							<KeyRound className="size-3.5" />
							{provider.apiKey.name || t("providerLogin.method.apiKey")}
						</Button>
					)}
					{provider.ambientOnly && <span className="text-xs text-muted-foreground">{t("providerLogin.method.envOnly")}</span>}
				</div>
			</TableCell>
			<TableCell className="align-top text-right">
				{row.loggedIn && (
					<Button size="sm" variant="ghost" disabled={disabled} onClick={() => onLogout(provider.id)}>
						<LogOut className="size-3.5" />
						{active ? t("providerLogin.action.logoutBusy") : t("providerLogin.action.logout")}
					</Button>
				)}
			</TableCell>
		</TableRow>
	);
}
