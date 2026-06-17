/**
 * FeishuConnectDialog — 飞书 Bot 连接配置弹窗
 *
 * 遵循 PiDeck 设计系统：CSS 变量 + ui-button / modal 体系。
 * 两种配置方式：手动配置（App ID + Secret）和扫码安装（二维码）。
 */

import { useState, useCallback, useEffect } from "react";
import QRCode from "qrcode";
import type { FeishuTestResult } from "../../../../shared/types";

type Props = {
	onClose: () => void;
	onConnect: (appId: string, appSecret: string, name: string, defaultUserOpenId?: string) => Promise<{ success: boolean; message: string }>;
	onTest: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	connecting: boolean;
};

type ConfigMode = "manual" | "qr";

export function FeishuConnectDialog({ onClose, onConnect, onTest, connecting }: Props) {
	const [mode, setMode] = useState<ConfigMode>("manual");

	// 手动配置
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [botName, setBotName] = useState("");
	const [defaultUserOpenId, setDefaultUserOpenId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<FeishuTestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [step, setStep] = useState<"input" | "testing" | "connecting">("input");

	// 二维码
	const [qrLink, setQrLink] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const [qrGenerating, setQrGenerating] = useState(false);
	const [showHelp, setShowHelp] = useState(false);

	// 防抖生成二维码
	const generateQr = useCallback(async (text: string) => {
		if (!text.trim()) {
			setQrDataUrl(null);
			return;
		}
		setQrGenerating(true);
		try {
			const dataUrl = await QRCode.toDataURL(text.trim(), {
				width: 280,
				margin: 2,
				color: { dark: "#000000", light: "#ffffff" },
				errorCorrectionLevel: "M",
			});
			setQrDataUrl(dataUrl);
		} catch {
			setQrDataUrl(null);
		} finally {
			setQrGenerating(false);
		}
	}, []);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (qrLink.trim()) {
				void generateQr(qrLink);
			} else {
				setQrDataUrl(null);
			}
		}, 400);
		return () => clearTimeout(timer);
	}, [qrLink, generateQr]);

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

				{/* ── 模式切换标签 ── */}
				<div className="feishu-mode-tabs">
					<button
						className={`feishu-mode-tab${mode === "manual" ? " active" : ""}`}
						onClick={() => setMode("manual")}
					>
						手动配置
					</button>
					<button
						className={`feishu-mode-tab${mode === "qr" ? " active" : ""}`}
						onClick={() => setMode("qr")}
					>
						扫码安装
					</button>
				</div>

				{/* ── 内容区 ── */}
				<div className="feishu-modal-body">
					{mode === "manual" ? (
						<>
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
						</>
					) : (
						/* ── 扫码模式 ── */
						<div className="feishu-qr-section">
							<p className="feishu-qr-hint">
								在飞书开放平台「应用发布」页面复制安装链接，
								<br />
								粘贴到下方即可生成二维码，用手机飞书扫码安装。
							</p>

							{/* Bot 安装链接 */}
							<div className="feishu-field" style={{ textAlign: "left", marginBottom: "var(--space-4)" }}>
								<label>Bot 安装链接</label>
								<input
									className="feishu-input feishu-input-mono"
									type="text"
									value={qrLink}
									onChange={(e) => setQrLink(e.target.value)}
									placeholder="https://applink.feishu.cn/client/bot/..."
								/>
							</div>

							{/* 二维码 */}
							<div className="feishu-qr-frame">
								{qrGenerating ? (
									<span style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
										生成中…
									</span>
								) : qrDataUrl ? (
									<img src={qrDataUrl} alt="飞书 Bot 安装二维码" />
								) : (
									<div className="feishu-qr-placeholder">
										<div className="feishu-qr-placeholder-icon">📱</div>
										<div>等待输入链接</div>
									</div>
								)}
							</div>

							{/* 二维码操作按钮 */}
							{qrDataUrl && (
								<div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "center", marginBottom: "var(--space-2)" }}>
									<button
										className="ui-button ui-button-sm"
										onClick={() => navigator.clipboard.writeText(qrLink).catch(() => {})}
									>
										复制链接
									</button>
									<button
										className="ui-button ui-button-sm"
										onClick={() => {
											const a = document.createElement("a");
											a.href = qrDataUrl;
											a.download = "feishu-bot-qr.png";
											a.click();
										}}
									>
										下载二维码
									</button>
								</div>
							)}

							{/* 帮助提示 */}
							<button
								className="feishu-help-toggle"
								onClick={() => setShowHelp((v) => !v)}
								style={{ textAlign: "center" }}
							>
								{showHelp ? "收起" : "💡 如何获取安装链接？"}
							</button>
							{showHelp && (
								<div className="feishu-help-content" style={{ textAlign: "left" }}>
									<p>1. 前往{" "}
										<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
											飞书开放平台
										</a>{" "}
										→ 你的应用
									</p>
									<p>2. 左侧菜单 → <strong>应用发布</strong></p>
									<p>3. 在「应用可用范围」区域点击「分享应用」</p>
									<p>4. 选择「复制链接」获取安装链接</p>
									<p>5. 粘贴到上方输入框，生成二维码</p>
									<p style={{ marginTop: "var(--space-1)", color: "var(--color-warning)" }}>
										⚠ 注意：应用必须先发布并通过审核，才能生成有效的安装链接。
									</p>
								</div>
							)}
						</div>
					)}
				</div>

				{/* ── 底部帮助（手动模式） ── */}
				{mode === "manual" && (
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
				)}
			</div>
		</div>
	);
}
