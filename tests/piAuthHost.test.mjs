import assert from "node:assert/strict";
import test from "node:test";
import { createFakePiPackage, messagesOfType, resultOf, runAuthHost } from "./helpers/piAuthHostDriver.mjs";

/**
 * 认证助手（resources/pi-auth-host.mjs）协议测试。
 *
 * 助手是宿主弹框与 pi 官方登录流程之间的唯一桥梁：pi 自己有网络/浏览器/回调服务，
 * 助手只负责把 notify/prompt 折成 NDJSON。这里用假 pi SDK 覆盖每类流程，
 * 不碰真实 pi、不碰网络，也不产生任何真实凭据。
 */

async function withFakePi(fn) {
	const fake = await createFakePiPackage();
	try {
		return await fn(fake);
	} finally {
		await fake.cleanup();
	}
}

test("list 返回 pi 自带供应商描述、已登录状态，并过滤无认证方式的供应商", async () => {
	await withFakePi(async (fake) => {
		const { code, messages } = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "list" }] });
		assert.equal(code, 0);
		assert.equal(messages[0].type, "ready");
		assert.equal(messages[0].protocolVersion, 1);
		assert.equal(messages[0].piVersion, "9.9.9-test");

		const providersMessage = messagesOfType(messages, "providers").at(-1);
		assert.equal(providersMessage.piVersion, "9.9.9-test");
		// no-auth 没有任何认证方式，宿主无法渲染，必须过滤；其余按 name 排序（按名字比对，不锁死 locale 的排序细节）
		const ids = providersMessage.providers.map((provider) => provider.id);
		assert.deepEqual([...ids].sort(), ["ambient-only", "both", "cancel-provider", "custom-models-json", "device-provider", "ext-provider", "fail-provider", "key-only", "oauth-basic", "out-of-band-provider"]);
		const names = providersMessage.providers.map((provider) => provider.name);
		assert.deepEqual(
			names,
			[...names].sort((a, b) => a.localeCompare(b)),
		);

		// oauth 选项用 loginLabel（"Sign in with ..."）作展示文案
		const oauthBasic = providersMessage.providers.find((provider) => provider.id === "oauth-basic");
		assert.deepEqual(oauthBasic.oauth, { label: "Sign in with Basic", isSubscription: true });
		assert.equal(oauthBasic.apiKey, undefined);
		assert.equal(oauthBasic.credential, undefined);

		const ambient = providersMessage.providers.find((provider) => provider.id === "ambient-only");
		assert.equal(ambient.apiKey.canLogin, false);
		assert.equal(ambient.ambientOnly, true);

		const both = providersMessage.providers.find((provider) => provider.id === "both");
		assert.equal(both.oauth.label, "Both OAuth");
		assert.equal(both.apiKey.canLogin, true);
		assert.equal(both.ambientOnly, false);

		// 已登录状态由 pi 自己（auth.json）给出，不是宿主猜的
		assert.deepEqual(both.credential, { type: "oauth" });
		assert.deepEqual(providersMessage.providers.find((provider) => provider.id === "key-only").credential, { type: "api_key" });

		// builtIn 用来让宿主滤掉 models.json 自定义供应商：内置目录里的为 true，
		// 自定义的为 false；扩展注册的（getRegisteredProviderIds）同样算 pi 支持。
		assert.equal(oauthBasic.builtIn, true);
		assert.equal(providersMessage.providers.find((provider) => provider.id === "custom-models-json").builtIn, false);
		assert.equal(providersMessage.providers.find((provider) => provider.id === "ext-provider").builtIn, true);
	});
});

test("list：pi 运行时拿不到内置目录时不下 builtIn 结论（宿主按旧行为保留）", async () => {
	await withFakePi(async (fake) => {
		// FAKE_PI_LEGACY=1：假 runtime 不提供 defaultBuiltins / getRegisteredProviderIds，
		// 模拟 pi 改了内部结构或旧版本的 pi。
		const { messages } = await runAuthHost({ entry: fake.entry, env: { FAKE_PI_LEGACY: "1" }, commands: [{ cmd: "list" }] });
		const providers = messagesOfType(messages, "providers").at(-1).providers;
		assert.ok(providers.length > 0, "判不出内置与否时不能把列表清空");
		// builtIn 判定不出来就不写该字段（JSON 会丢 undefined），宿主按「未知=保留」处理。
		assert.ok(
			providers.every((provider) => provider.builtIn === undefined),
			"没有依据时不得凭空标记 builtIn",
		);
	});
});

test("请求了供应商不支持的登录方式时直接给出 unsupported，不进入流程", async () => {
	await withFakePi(async (fake) => {
		const oauthOnKeyOnly = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "login", providerId: "key-only", type: "oauth" }] });
		assert.deepEqual(resultOf(oauthOnKeyOnly.messages).error, {
			message: "Provider key-only has no subscription login",
			kind: "unsupported",
		});

		const apiKeyOnAmbient = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "login", providerId: "ambient-only", type: "api_key" }] });
		assert.deepEqual(resultOf(apiKeyOnAmbient.messages).error, {
			message: "Provider ambient-only can only use ambient credentials",
			kind: "unsupported",
		});

		const unknown = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "login", providerId: "ghost", type: "oauth" }] });
		assert.equal(resultOf(unknown.messages).error.kind, "unknown-provider");
	});
});

test("login 透传 auth_url 事件，manual_code 回填后可成功", async () => {
	await withFakePi(async (fake) => {
		const { code, messages } = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "oauth-basic", type: "oauth" }],
			onMessage: (message, send) => {
				if (message.type === "prompt") send({ cmd: "answer", id: message.id, value: "CODE-123" });
			},
		});
		assert.equal(code, 0);
		const prompt = messagesOfType(messages, "prompt")[0];
		assert.equal(prompt.prompt.kind, "manual_code");
		assert.equal(prompt.prompt.placeholder, "http://localhost:53692/callback");
		assert.deepEqual(
			messagesOfType(messages, "event").map((message) => message.event.type),
			["auth_url", "progress"],
		);
		const result = resultOf(messages);
		assert.equal(result.ok, true);
		assert.equal(result.cancelled, false);
	});
});

test("manual_code 回填错误时透传 pi 的失败原因，不静默成功", async () => {
	await withFakePi(async (fake) => {
		const { messages } = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "oauth-basic", type: "oauth" }],
			onMessage: (message, send) => {
				if (message.type === "prompt") send({ cmd: "answer", id: message.id, value: "not-the-code" });
			},
		});
		const result = resultOf(messages);
		assert.equal(result.ok, false);
		assert.equal(result.cancelled, false);
		assert.equal(result.error.message, "Missing authorization code");
	});
});

test("设备码流程透传 device_code 事件与 select 选项并回填选择", async () => {
	await withFakePi(async (fake) => {
		const { messages } = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "device-provider", type: "oauth" }],
			onMessage: (message, send) => {
				if (message.type === "prompt") send({ cmd: "answer", id: message.id, value: "acct-2" });
			},
		});
		const deviceCode = messagesOfType(messages, "event").find((message) => message.event.type === "device_code");
		assert.equal(deviceCode.event.userCode, "ABCD-1234");
		assert.equal(deviceCode.event.intervalSeconds, 5);
		const prompt = messagesOfType(messages, "prompt")[0];
		assert.equal(prompt.prompt.kind, "select");
		// JSON 会丢掉 undefined 字段，所以无描述的选项不带 description
		assert.deepEqual(prompt.prompt.options, [
			{ id: "acct-1", label: "Account 1", description: "first" },
			{ id: "acct-2", label: "Account 2" },
		]);
		assert.equal(resultOf(messages).ok, true);
	});
});

test("宿主 cancel 时结果标记 cancelled，不当作登录失败", async () => {
	await withFakePi(async (fake) => {
		const { messages } = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "cancel-provider", type: "oauth" }],
			onMessage: (message, send) => {
				if (message.type === "event" && message.event.type === "auth_url") send({ cmd: "cancel" });
			},
		});
		const result = resultOf(messages);
		assert.equal(result.ok, false);
		assert.equal(result.cancelled, true);
		assert.equal(result.error, undefined);
	});
});

test("pi 侧取消 prompt（回调已拿到授权码）时通知宿主并继续完成登录", async () => {
	await withFakePi(async (fake) => {
		const { messages } = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "out-of-band-provider", type: "oauth" }],
		});
		const prompt = messagesOfType(messages, "prompt")[0];
		const cancelled = messagesOfType(messages, "prompt-cancelled")[0];
		assert.equal(cancelled.id, prompt.id);
		assert.equal(resultOf(messages).ok, true);
	});
});

test("登录失败时透传错误信息", async () => {
	await withFakePi(async (fake) => {
		const { messages } = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "login", providerId: "fail-provider", type: "oauth" }] });
		const result = resultOf(messages);
		assert.equal(result.ok, false);
		assert.equal(result.error.message, "boom: token exchange failed");
	});
});

test("api_key 流程支持密钥输入，且 text 型问题允许空回答", async () => {
	await withFakePi(async (fake) => {
		const missing = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "key-only", type: "api_key" }],
			onMessage: (message, send) => {
				if (message.type === "prompt") send({ cmd: "answer", id: message.id, value: "" });
			},
		});
		assert.equal(messagesOfType(missing.messages, "prompt")[0].prompt.kind, "secret");
		assert.equal(resultOf(missing.messages).error.message, "Missing API key");

		const blankAllowed = await runAuthHost({
			entry: fake.entry,
			commands: [{ cmd: "login", providerId: "both", type: "api_key" }],
			onMessage: (message, send) => {
				if (message.type === "prompt") send({ cmd: "answer", id: message.id, value: "" });
			},
		});
		// 空串是合法回答（GitHub Copilot 的「留空 = github.com」这类问题），不能当成取消
		assert.equal(resultOf(blankAllowed.messages).ok, true);
	});
});

test("logout 成功与失败都返回结构化结果而非 fatal", async () => {
	await withFakePi(async (fake) => {
		const ok = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "logout", providerId: "key-only" }] });
		assert.deepEqual(resultOf(ok.messages), { type: "result", ok: true, cancelled: false, command: "logout", providerId: "key-only" });

		const failed = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "logout", providerId: "unknown-provider" }] });
		const result = resultOf(failed.messages);
		assert.equal(result.ok, false);
		assert.equal(result.command, "logout");
		assert.equal(result.error.message, "Unknown provider: unknown-provider");
	});
});

test("缺少 SDK 入口或入口无法导入时报 fatal，宿主可降级提示", async () => {
	const missingEnv = await runAuthHost({ commands: [{ cmd: "list" }] });
	assert.deepEqual(missingEnv.messages[0], { type: "fatal", stage: "startup", message: "PIDECK_PI_SDK_ENTRY is not set" });
	assert.equal(missingEnv.code, 1);

	const unimportable = await runAuthHost({ entry: "D:/nonexistent-pi/dist/index.js", commands: [{ cmd: "list" }] });
	// ready 只在 SDK 与 ModelRuntime 都就绪后才发，所以加载失败时没有 ready
	const fatal = messagesOfType(unimportable.messages, "fatal")[0];
	assert.equal(unimportable.messages[0].type, "fatal");
	assert.equal(fatal.stage, "sdk-load");
	assert.match(fatal.message, /Cannot find module|ERR_MODULE_NOT_FOUND|not supported/i);
});

test("未知命令报 protocol fatal，不静默忽略", async () => {
	await withFakePi(async (fake) => {
		const { messages, code } = await runAuthHost({ entry: fake.entry, commands: [{ cmd: "nope" }] });
		const fatal = messagesOfType(messages, "fatal")[0];
		assert.equal(fatal.stage, "protocol");
		assert.match(fatal.message, /unknown command: nope/);
		assert.equal(code, 1);
	});
});
