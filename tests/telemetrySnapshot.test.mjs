import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 遥测快照是纯函数：所有运行时事实由装配层注入，这里验证映射规则与默认值兜底。
// 隐私红线由属性清单保证——只含版本/平台/开关/计数，任何路径、名称、内容字段都不允许出现。
const { collectTelemetrySnapshot } = loadTsCommonJs("src/main/telemetry/telemetrySnapshot.ts", { stubs: {} });

function createDeps(overrides = {}) {
	return {
		settings: {
			language: "zh-CN",
			theme: "dark",
			themeSkin: "classic-green",
			petEnabled: true,
			floatingBallEnabled: false,
			webServiceEnabled: true,
			cuaEnabled: false,
			standbyRuntimeEnabled: false,
			wslEnabled: false,
			desktopProxyEnabled: true,
			piProxyEnabled: false,
			hiddenModules: ["pet", "dsh"],
		},
		sessionsTotal: 42,
		projectsTotal: 7,
		agentsActive: 3,
		feishuBotsTotal: 1,
		automationTasksTotal: 2,
		systemLocale: "zh-CN",
		portable: false,
		uptimeMs: 12345.6,
		osRelease: "10.0.22631",
		...overrides,
	};
}

test("maps settings and counts into heartbeat snapshot properties", () => {
	const snapshot = collectTelemetrySnapshot(createDeps());

	assert.equal(snapshot.os_version, "10.0.22631");
	assert.equal(snapshot.os_locale, "zh-CN");
	assert.equal(snapshot.install_mode, "installed");
	assert.equal(snapshot.language, "zh-CN");
	assert.equal(snapshot.theme, "dark");
	assert.equal(snapshot.theme_skin, "classic-green");
	assert.equal(snapshot.startup_ms, 12346);
	assert.equal(snapshot.sessions_total, 42);
	assert.equal(snapshot.projects_total, 7);
	assert.equal(snapshot.agents_active, 3);
	assert.equal(snapshot.automation_tasks_total, 2);
	assert.equal(snapshot.feishu_bots_total, 1);
	assert.equal(snapshot.feature_pet, true);
	assert.equal(snapshot.feature_floating_ball, false);
	assert.equal(snapshot.feature_web_service, true);
	assert.equal(snapshot.feature_cua, false);
	assert.equal(snapshot.feature_standby, false);
	assert.equal(snapshot.feature_wsl, false);
	assert.equal(snapshot.feature_desktop_proxy, true);
	assert.equal(snapshot.feature_pi_proxy, false);
	assert.equal(snapshot.feature_feishu, true);
	assert.equal(snapshot.hidden_modules_total, 2);
	// vm 沙箱返回的数组是另一个 realm 的对象，deepEqual 会比原型，用 JSON 比较内容
	assert.equal(JSON.stringify(snapshot.hidden_modules), JSON.stringify(["pet", "dsh"]));
});

test("portable builds report install_mode=portable", () => {
	const snapshot = collectTelemetrySnapshot(createDeps({ portable: true }));
	assert.equal(snapshot.install_mode, "portable");
});

test("standby defaults to enabled and feishu adoption derives from bot count", () => {
	const deps = createDeps({ feishuBotsTotal: 0 });
	delete deps.settings.standbyRuntimeEnabled;
	const snapshot = collectTelemetrySnapshot(deps);

	assert.equal(snapshot.feature_standby, true);
	assert.equal(snapshot.feature_feishu, false);
	assert.equal(snapshot.feishu_bots_total, 0);
});

test("missing hiddenModules falls back to empty list without mutating settings", () => {
	const deps = createDeps();
	delete deps.settings.hiddenModules;
	const snapshot = collectTelemetrySnapshot(deps);

	assert.equal(snapshot.hidden_modules_total, 0);
	assert.equal(JSON.stringify(snapshot.hidden_modules), "[]");
});

test("snapshot contains only anonymous stats: no paths, names, secrets, or content fields", () => {
	const snapshot = collectTelemetrySnapshot(createDeps());
	const serialized = JSON.stringify(snapshot).toLowerCase();
	for (const banned of ["path", "secret", "token", "api_key", "apikey", "password", "prompt", "message", "filename", "projectname", "project_name"]) {
		assert.equal(serialized.includes(banned), false, `snapshot must not contain ${banned}`);
	}
});
