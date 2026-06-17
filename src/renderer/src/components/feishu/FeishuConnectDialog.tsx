/**
 * FeishuConnectDialog — 飞书 Bot 连接配置弹窗
 *
 * 遵循 PiDeck 设计系统：CSS 变量 + ui-button / modal 体系。
 * 仅支持手动配置（App ID + Secret）。
 */

import { useState, useCallback } from "react";
import type { FeishuTestResult } from "../../../../shared/types";

type Props = {
	onClose: () => void;
	onConnect: (appId: string, appSecret: string, name: string, defaultUserOpenId?: string) => Promise<{ success: boolean; message: string }>;
	onTest: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	connecting: boolean;
};

export function FeishuConnectDialog({ onClose, onConnect, onTest, connecting }: Props) {
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [botName, setBotName] = useState("");
	const [defaultUserOpenId, setDefaultUserOpenId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<FeishuTestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [step, setStep] = useState<"input" | "testing" | "connecting">("input");
	const [showHelp, setShowHelp] = useState(false);

	const handleTest = useCallback(async () => {
		if (!appId.trim() || !appSecret.trim()) {
			setError("请填写 App ID 和 App Secret");
			return;
		}
		setTesting(true);
		setError(null);
		setTestResult(null);
		try {
			const result = await onTest(appId.trim(), appSecret.trim());
			setTestResult(result);
			if (result.success) setStep("testing");
		} catch (e) {
			setError(e instanceof Error ? e.message : "测试失败");
		} finally {
			setTesting(false);
		}
	}, [appId, appSecret, onTest]);

	const handleConnect = useCallback(async () => {
		if (!appId.trim() || !appSecret.trim()) {
			setError("请填写 App ID 和 App Secret");
			return;
		}
		setError(null);
		setStep("connecting");
		const name = botName.trim() || "飞书机器人";
		const userOpenId = defaultUserOpenId.trim() || undefined;
		const result = await onConnect(appId.trim(), appSecret.trim(), name, userOpenId);
		if (!result.success) {
			setError(result.message);
			setStep("testing");
		}
	}, [appId, appSecret, botName, defaultUserOpenId, onConnect]);

	const isBusy = connecting || step === "connecting";

	return (
		<div className="feishu-connect-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
			<div className="feishu-connect-dialog">
				{/* ── 头部 ── */}
				<div className="modal-header">
					<strong>连接飞书 Bot</strong>
					<button onClick={onClose}>✕</button>
				</div>

				{/* ── 内容区 ── */}
				<div className="feishu-modal-body">
					{/* App ID */}
					<div className="feishu-field">
						<label>App ID</label>
						<input
							className="feishu-input feishu-input-mono"
							type="text"
							value={appId}
							onChange={(e) => { setAppId(e.target.value); setError(null); setTestResult(null); }}
							placeholder="cli_xxxxxxxxxxxx"
							disabled={isBusy}
						/>
					</div>

					{/* App Secret */}
					<div className="feishu-field">
						<label>App Secret</label>
						<input
							className="feishu-input feishu-input-mono"
							type="password"
							value={appSecret}
							onChange={(e) => { setAppSecret(e.target.value); setError(null); setTestResult(null); }}
							placeholder="••••••••••••••••"
							disabled={isBusy}
						/>
					</div>

					{/* Bot 名称 */}
					<div className="feishu-field">
						<label>
							Bot 名称 <span className="feishu-field-optional">(可选)</span>
						</label>
						<input
							className="feishu-input"
							type="text"
							value={botName}
							onChange={(e) => setBotName(e.target.value)}
							placeholder="我的飞书助手"
							disabled={isBusy}
						/>
					</div>

					{/* 分隔 */}
					<hr className="feishu-divider" />

					{/* Open ID */}
					<div className="feishu-field">
						<label>
							你的 Open ID <span className="feishu-field-optional">(可选，用于自动拉群)</span>
						</label>
						<input
							className="feishu-input feishu-input-mono"
							type="text"
							value={defaultUserOpenId}
							onChange={(e) => setDefaultUserOpenId(e.target.value)}
							placeholder="ou_xxxxxxxxxxxxxxxx"
							disabled={isBusy}
						/>
						<div className="feishu-field-hint">
							如何获取：在飞书给 Bot 发 <code>/whoami</code> 即可查看
						</div>
					</div>

					{/* 错误提示 */}
					{error && (
						<div className="feishu-error-banner">{error}</div>
					)}

					{/* 测试结果 */}
					{testResult && (
						<div className={`feishu-test-result ${testResult.success ? "success" : "warning"}`}>
							{testResult.success ? "✓" : "⚠"} {testResult.message}
							{testResult.botName && ` (${testResult.botName})`}
						</div>
					)}

					{/* 按钮 */}
					<div className="feishu-button-row">
						{step === "input" || step === "testing" ? (
							<>
								<button
									className="ui-button ui-button-secondary"
									onClick={handleTest}
									disabled={testing || !appId.trim() || !appSecret.trim()}
									style={{ flex: 1 }}
								>
									{testing ? "测试中…" : "测试连接"}
								</button>
								{step === "testing" && (
									<button
										className="ui-button ui-button-primary"
										onClick={handleConnect}
										disabled={connecting}
										style={{ flex: 1 }}
									>
										{connecting ? "连接中…" : "连接"}
									</button>
								)}
							</>
						) : (
							<div style={{ width: "100%", textAlign: "center", padding: "var(--space-3)", color: "var(--color-accent)", fontSize: "var(--font-size-caption)" }}>
								正在连接飞书…
							</div>
						)}
					</div>
				</div>

				{/* ── 底部帮助 ── */}
				<div className="feishu-help-footer">
					<button
						className="feishu-help-toggle"
						onClick={() => setShowHelp((v) => !v)}
					>
						{showHelp ? "收起帮助" : "📋 如何获取 App ID 和 App Secret？"}
					</button>
					{showHelp && (
						<div className="feishu-help-content">
							<p>1. 打开{" "}
								<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
									飞书开放平台
								</a>
							</p>
							<p>2. 创建企业自建应用</p>
							<p>3. 在「凭证与基础信息」中获取 App ID 和 App Secret</p>
							<p>4. 在「权限管理」中开启以下权限：</p>
							<ul>
								<li>im:message — 获取消息</li>
								<li>im:message:send_as_bot — 发送消息</li>
								<li>im:chat — 获取群聊信息</li>
								<li>im:resource — 下载文件/图片</li>
							</ul>
							<p>5. 在「事件订阅」中开启 im.message.receive_v1（WebSocket 长连接模式）</p>
							<p>6. 发布应用并审核通过</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
