/**
 * OAuth 内置凭据（对齐 Netcatty：clientId 由应用方注册，构建/部署期注入，不进代码库）。
 *
 * 通过环境变量注入（dev 直接生效；打包构建时由部署方设置）：
 * - VITE_SYNC_GITHUB_CLIENT_ID   ：GitHub OAuth App Client ID（Device Flow 公共客户端）
 * - VITE_SYNC_ONEDRIVE_CLIENT_ID ：Azure「移动和桌面应用程序」Client ID
 * - VITE_SYNC_GOOGLE_CLIENT_ID   ：Google Cloud「桌面应用」OAuth Client ID
 * - VITE_SYNC_GOOGLE_CLIENT_SECRET ：Google 桌面应用 Client Secret（PKCE 可省略）
 *
 * GitHub 是 Device Flow 公共客户端（无密钥），内置公开默认值 DEFAULT_GITHUB_CLIENT_ID：
 * 未注入 VITE_SYNC_GITHUB_CLIENT_ID 时直接生效（零配置），注入时以注入值为准；
 * 其余 provider 未注入时回退到「用户自备」模式（BYO，当前设置页输入框）。
 */

export interface OAuthBuiltinCredentials {
	githubClientId: string;
	onedriveClientId: string;
	googleClientId: string;
	googleClientSecret: string;
}

/** GitHub OAuth App 公开 Client ID（Device Flow 公共客户端，无密钥；应用方注册的默认值）。 */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23liDM74yxq3HOLCRS";

export function resolveOauthBuiltinCredentials(
	env: Record<string, string | undefined> = process.env,
): OAuthBuiltinCredentials {
	return {
		githubClientId: (env.VITE_SYNC_GITHUB_CLIENT_ID ?? "").trim() || DEFAULT_GITHUB_CLIENT_ID,
		onedriveClientId: (env.VITE_SYNC_ONEDRIVE_CLIENT_ID ?? "").trim(),
		googleClientId: (env.VITE_SYNC_GOOGLE_CLIENT_ID ?? "").trim(),
		googleClientSecret: (env.VITE_SYNC_GOOGLE_CLIENT_SECRET ?? "").trim(),
	};
}

export const OAUTH_BUILTIN_CREDENTIALS: OAuthBuiltinCredentials = resolveOauthBuiltinCredentials();
