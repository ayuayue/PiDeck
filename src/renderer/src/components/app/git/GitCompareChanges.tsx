import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2 } from "lucide-react";
import type { GitChangedFile } from "../../../../../shared/types";
import { GitStatus } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { localGitOperationErrorText } from "../../../utils/gitErrorPresentation";
import { showNotice } from "../../../utils/notice";
import { Button } from "../../ui-shadcn/button";
import { Label } from "../../ui-shadcn/label";
import { VirtualStack } from "../../ui-shadcn/virtual-stack";
import { GitCompactFilter, PaneHeader } from "./GitPanelControls";
import { ResourceRow } from "./GitResourceTree";

/**
 * 一次分支对比的答案。`ahead/behind` 只有三点语义（merge-base）才有；
 * 两树比较（远端 helper 的默认语义）没有这组计数，缺省就不显示，不填 0 冒充。
 */
export type CompareChangesResult = { files: GitChangedFile[]; ahead?: number; behind?: number };

export type CompareChangesProps = {
	paneIdPrefix: string;
	projectId: string;
	branches: string[];
	branchCompare: (projectId: string, base: string, target: string) => Promise<CompareChangesResult>;
	/** 对比能力：关闭时整块只读、不发请求（能力条解释原因）。 */
	enabled: boolean;
	open: boolean;
	height: number;
	onToggle: () => void;
	historyRepoPath?: string;
	historyRepoOptions?: { value: string; label: string }[];
	onSelectHistoryRepo?: (path: string) => void;
};

/**
 * 「比较更改」分区：本机与远端同一条渲染，数据由宿主注入。
 * 从 GitPanel 抽出来是为了让面板文件只留装配面（同 RemoteGitChangesSection 的拆分理由）。
 */
export function CompareChanges(props: CompareChangesProps) {
	const [base, setBase] = useState("");
	// 对比结果列表的滚动窗：交给 VirtualStack 复用（它要拿它当 getScrollElement）。
	const compareScrollRef = useRef<HTMLDivElement>(null);
	const [target, setTarget] = useState("");
	const [result, setResult] = useState<CompareChangesResult | null>(null);
	const [loading, setLoading] = useState(false);
	const requestSequence = useRef(0);

	useEffect(() => {
		// Branch names overlap across projects; comparison state must not cross that boundary.
		requestSequence.current += 1;
		setBase("");
		setTarget("");
		setResult(null);
		setLoading(false);
	}, [props.projectId]);

	useEffect(() => {
		if (props.branches.length >= 2 && (!base || !target)) {
			setTarget(props.branches[0] ?? "");
			setBase(props.branches[1] ?? "");
		}
	}, [base, props.branches, target]);

	const run = async () => {
		if (!props.enabled) return;
		if (!base || !target || base === target) return;
		const request = ++requestSequence.current;
		const projectId = props.projectId;
		setLoading(true);
		try {
			const next = await props.branchCompare(projectId, base, target);
			if (request === requestSequence.current && projectId === props.projectId) setResult(next);
		} catch (caught) {
			if (request === requestSequence.current && projectId === props.projectId) {
				setResult(null);
				// 对比失败（分支被删/仓库异常）不再占面板错误区，toast 用完即走。
				showNotice(localGitOperationErrorText(caught) || t("git.compareFailed"), 8000, "error", t("git.compareFailed"));
			}
		} finally {
			if (request === requestSequence.current && projectId === props.projectId) setLoading(false);
		}
	};

	// 两树比较没有 ahead/behind：只显示改动文件数，不让 0/0 读成“完全一致”。
	const hasCounters = result !== null && result.ahead !== undefined && result.behind !== undefined;

	return (
		<section
			id={`git-pane-${props.paneIdPrefix}-compare`}
			className={`flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? " h-[calc(var(--git-pane-height)+32px)]" : " h-[32px]"}`}
			style={{ "--git-pane-height": `${props.height}px` } as CSSProperties}
		>
			<PaneHeader id={`${props.paneIdPrefix}-compare`} title={t("git.compareChanges")} count={result?.files.length} open={props.open} onToggle={props.onToggle}>
				{props.historyRepoOptions && props.historyRepoOptions.length > 1 && props.onSelectHistoryRepo && <GitCompactFilter value={props.historyRepoPath ?? ""} ariaLabel={t("git.switchRepository")} options={props.historyRepoOptions} onChange={props.onSelectHistoryRepo} compact className="max-w-[8.5rem]" />}
			</PaneHeader>
			{/* scroll-ok: nested —— 一个滚动窗里两段：上方 base/head 选择控件 + 下方改动文件列表。虚拟器只算得出其中一段的高度，跟容器 scrollHeight 对不上，滚动位置会错。 */}
			{props.open && (
				<div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
					<div className="git-compare-controls">
						<Label>
							<span>{t("git.base")}</span>
							<GitCompactFilter
								value={base}
								ariaLabel={t("git.base")}
								options={[
									{ value: "", label: t("git.selectBase") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setBase(value)}
							/>
						</Label>
						<span className="flex items-center pb-px text-[var(--git-desc-fg)]" aria-hidden="true">
							→
						</span>
						<Label>
							<span>{t("git.compare")}</span>
							<GitCompactFilter
								value={target}
								ariaLabel={t("git.compare")}
								options={[
									{ value: "", label: t("git.selectCompare") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setTarget(value)}
							/>
						</Label>
						<Button type="button" variant="ghost" size="sm" className=" h-auto px-2.5 text-control" disabled={!props.enabled || !base || !target || base === target || loading} onClick={() => void run()}>
							{loading ? <Loader2 size={14} className="animate-pideck-spin" /> : t("git.compare")}
						</Button>
					</div>
					{result && (
						<>
							<div className="flex-[0_0_auto] border-t border-[var(--git-panel-border)] px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
								{hasCounters ? t("git.compareSummary", { ahead: result.ahead ?? 0, behind: result.behind ?? 0, count: result.files.length }) : t("git.filesChanged", { count: result.files.length })}
							</div>
							{/*
							     对比结果文件列表：行数 = 两次提交/分支之间改动的文件数，大重构可以上百个，
							     而外层是 flex 填充的滚动窗 —— 正是「行数随数据增长 + 有视口」。
							     行高固定（ResourceRow 是单行 22px 级），measureElement 实测后基本不抖动。
							*/}
							<div ref={compareScrollRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
								<VirtualStack items={result.files} scrollRef={compareScrollRef} getKey={(file) => file.path} estimateHeight={22} renderItem={(file) => <ResourceRow status={0 as GitStatus} letter="" path={file.path} compareStatus={file.status} />} />
							</div>
						</>
					)}
					{!result && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-2.5 text-control text-[var(--git-desc-fg)]">{t("git.compareHint")}</div>}
				</div>
			)}
		</section>
	);
}
