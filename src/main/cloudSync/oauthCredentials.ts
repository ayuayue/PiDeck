/**
 * OAuth 内置凭据（对齐 Netcatty：clientId 由应用方注册，构建/部署期注入，不进代码库）。
 *
 * 通过环境变量注入（dev 直接生效；打包构建时由部署方设置）：
 * - VITE_SYNC_ONEDRIVE_CLIENT_ID   ：Azure「移动和桌面应用程序」Client ID
 * - VITE_SYNC_GOOGLE_CLIENT_ID     ：Google Cloud「桌面应用」OAuth Client ID
 * - VITE_SYNC_GOOGLE_CLIENT_SECRET ：Google 桌面应用 Client Secret（PKCE 可省略）
 *
 * 注入后设置页隐藏凭据输入、用户点「通过浏览器连接」直接授权（零配置）；
 * 未注入时回退到「用户自备」模式（BYO，当前设置页输入框）。
 */

export interface OAuthBuiltinCredentials {
	onedriveClientId: string;
	googleClientId: string;
	googleClientSecret: string;
}

export function resolveOauthBuiltinCredentials(
	env: Record<string, string | undefined> = process.env,
): OAuthBuiltinCredentials {
	return {
		onedriveClientId: (env.VITE_SYNC_ONEDRIVE_CLIENT_ID ?? "").trim(),
		googleClientId: (env.VITE_SYNC_GOOGLE_CLIENT_ID ?? "").trim(),
		googleClientSecret: (env.VITE_SYNC_GOOGLE_CLIENT_SECRET ?? "").trim(),
	};
}

export const OAUTH_BUILTIN_CREDENTIALS: OAuthBuiltinCredentials = resolveOauthBuiltinCredentials();
