import { ShieldAlert } from "lucide-react";
import type { AgentUiRequest } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { parseSecurityConfirmTitle, shouldSuppressAskClick } from "../../utils/askUi";
import { Button } from "../ui-shadcn/button";
import { ApprovalCard } from "../ui-shadcn/approval-card";

/**
 * 工具中文名 i18n key（与 config/SecuritySection 的 security.tool.* 同一套）。
 * 未知工具兜底显示原始工具名（技术标识）。
 */
const TOOL_LABEL_KEYS: Record<string, TranslationKey> = {
	read: "security.tool.read",
	write: "security.tool.write",
	edit: "security.tool.edit",
	bash: "security.tool.bash",
	grep: "security.tool.grep",
	find: "security.tool.find",
	ls: "security.tool.ls",
	ask_question: "security.tool.ask_question",
};

function toolLabel(tool: string): string {
	const key = TOOL_LABEL_KEYS[tool];
	return key ? t(key) : tool;
}

/**
 * 安全确认专用卡片（pi-deck-security-gate 拦截「ask」动作时使用）。
 *
 * 与普通 Ask 卡的区别：普通 Ask 把标题+详情压进两行摘要（line-clamp），
 * 用户只能看到「是否审批」却看不到「审批什么」。这里把工具名 / 等级 / 详情
 * 拆成独立区块，命令或文件路径用等宽块完整展示（超长滚动），
 * 允许/拒绝按钮响应值直接回传扩展下发的原始选项字符串，保持契约一致。
 */
export function SecurityConfirmCard(props: { request: AgentUiRequest; responding: boolean; open: boolean; onOpenChange: (open: boolean) => void; onRespond: (value: string) => void; onCancel: () => void }) {
	const info = parseSecurityConfirmTitle(props.request.title);
	// 本组件只应在解析出安全确认时渲染；兜底保护避免异常数据白屏
	if (!info) return null;

	// 允许/拒绝响应值 = 扩展下发的原始选项（默认按 options[0]/[1] 回传），
	// 不依赖渲染层硬编码文案，扩展侧 choice === "允许执行" 的判定才稳定。
	const options = props.request.options ?? [];
	const allowValue = options[0] ?? "允许执行";
	const denyValue = options[1] ?? "拒绝";

	return (
		<ApprovalCard
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={t("security.confirmTitle")}
			description={t("security.confirmQuestion")}
			status={t("ask.waiting")}
			statusTone="active"
			onCancel={props.onCancel}
			cancelDisabled={props.responding}
			cancelLabel={t("common.close")}
			className="ask-inline-bar ask-inline-bar--active w-full"
		>
			<div className="flex flex-col gap-2">
				{/* 工具 + 等级：一行徽标，明确「拦的是什么、在什么等级下」 */}
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
						<ShieldAlert size={12} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
						<span className="shrink-0">{t("security.confirmToolLabel")}</span>
						<span className="font-semibold text-text-primary">{toolLabel(info.tool)}</span>
					</span>
					{info.level ? (
						<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
							<span className="shrink-0">{t("security.confirmLevelLabel")}</span>
							<span className="font-semibold text-text-primary">{info.level}</span>
						</span>
					) : null}
				</div>

				{/* 详情区：命令/文件路径用等宽块完整展示，超长滚动，不再被两行摘要截断 */}
				<div className="rounded-md border border-border-subtle bg-bg-muted px-2.5 py-2">
					<div className="mb-1 text-micro font-semibold text-text-tertiary">{t("security.confirmDetailLabel")}</div>
					{info.detail ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-text-primary">{info.detail}</pre> : <div className="text-micro text-text-tertiary">{t("security.confirmDetailEmpty")}</div>}
				</div>

				{/* 允许/拒绝：主次分明，说明文案挂 title 供悬停查看 */}
				<div className="flex gap-2">
					<Button
						variant="default"
						className="h-8 px-3"
						disabled={props.responding}
						title={t("security.confirmAllowHint")}
						onClick={() => {
							// 划选详情的 mouseup 落在允许/拒绝上会冒充 click；本次按压新拖出的选区不提交。
							if (shouldSuppressAskClick()) return;
							props.onRespond(allowValue);
						}}
					>
						{t("security.confirmAllow")}
					</Button>
					<Button
						variant="outline"
						className="h-8 px-3"
						disabled={props.responding}
						title={t("security.confirmDenyHint")}
						onClick={() => {
							if (shouldSuppressAskClick()) return;
							props.onRespond(denyValue);
						}}
					>
						{t("security.confirmDeny")}
					</Button>
				</div>
			</div>
		</ApprovalCard>
	);
}
