/**
 * Pi 环境能力表（configEnvironmentModel）：一个环境能管理哪些配置页、切过去落在哪一页。
 *
 * 这三条是「切换环境」最容易做半截的地方，所以按纯规则钉住：
 * - ssh = models/auth/settings/trust/mcp：auth 只读（helper 只回答派生视图，凭据不跨机）；
 * - wsl 全文件（含 auth.json，本机 UNC + 发行版内原子替换），但不含 OAuth 与安全策略；
 * - 当前页在新环境不存在时必须落到第一页，不能停在一个导航里已经没有的 tab 上。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const model = loadTsCommonJs("src/renderer/src/config/configEnvironmentModel.ts");
const LOCAL = { kind: "local" };
const SSH = { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111" };
const WSL = { kind: "wsl" };

test("本机环境：全部配置页 + 安全策略 + 资源三页", () => {
	assert.deepEqual([...model.configTabsForTarget(LOCAL)], ["models", "auth", "oauth", "settings", "trust", "mcp", "raw"]);
	assert.equal(model.securityPageSupported(LOCAL), true);
	assert.equal(model.resourcePagesSupported(LOCAL), true);
});

test("WSL 环境：含凭据与源文件，但不含 OAuth / 安全策略", () => {
	assert.deepEqual([...model.configTabsForTarget(WSL)], ["models", "auth", "settings", "trust", "mcp", "raw"]);
	assert.equal(model.isConfigTabSupported(WSL, "auth"), true, "auth.json 在发行版 HOME 里，本机 UNC 可读写");
	assert.equal(model.isConfigTabSupported(WSL, "raw"), true);
	assert.equal(model.isConfigTabSupported(WSL, "oauth"), false, "OAuth 登录跑的是本机 pi 进程");
	assert.equal(model.securityPageSupported(WSL), false);
	assert.equal(model.resourcePagesSupported(WSL), true, "资源三页已按 WSL 目标路由");
});

test("SSH 环境：五个文件页（认证为只读派生视图），OAuth/源文件与资源、安全策略都不出现", () => {
	assert.deepEqual([...model.configTabsForTarget(SSH)], ["models", "auth", "settings", "trust", "mcp"]);
	assert.equal(model.isConfigTabSupported(SSH, "auth"), true, "只读派生视图：页面在，输入不在");
	for (const tab of ["oauth", "raw"]) assert.equal(model.isConfigTabSupported(SSH, tab), false, tab);
	assert.equal(model.securityPageSupported(SSH), false);
	assert.equal(model.resourcePagesSupported(SSH), false, "远端资源管理未路由：不给死入口");
});

test("切环境后的落点：仍支持就留在原地，否则回到该环境第一页", () => {
	assert.equal(model.resolveConfigTabForTarget(SSH, "trust"), "trust");
	assert.equal(model.resolveConfigTabForTarget(SSH, "auth"), "auth");
	assert.equal(model.resolveConfigTabForTarget(SSH, "raw"), "models");
	assert.equal(model.resolveConfigTabForTarget(WSL, "auth"), "auth");
	assert.equal(model.firstConfigTabForTarget(SSH), "models");
	assert.equal(model.firstConfigTabForTarget({ kind: "ssh", hostId: "unlisted" }), "models");
});

test("目标 key：同 kind 同 id 才是同一个环境（ssh/wsl 的 id 命名空间互不冒充）", () => {
	assert.equal(model.configTargetKey(LOCAL), "local");
	assert.equal(model.configTargetKey(SSH), "ssh:" + SSH.hostId);
	assert.equal(model.configTargetKey(WSL), "wsl");
	assert.notEqual(model.configTargetKey(SSH), model.configTargetKey({ kind: "wsl" }));
});

test("状态条说明按环境给：本机 / WSL / SSH 各一句，不会把 ssh 说成本机", () => {
	assert.equal(model.environmentScopeHintKey(LOCAL), "config.env.scopeLocal");
	assert.equal(model.environmentScopeHintKey(WSL), "config.env.scopeWsl");
	assert.equal(model.environmentScopeHintKey(SSH), "config.env.scopeSsh");
});
