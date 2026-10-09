import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const ipv4 = { address: "192.168.1.5", interfaceName: "LAN", cidr: null, isPrivate: true, family: "IPv4" };
const otherIpv4 = { ...ipv4, address: "10.0.0.5" };
const ipv6 = { address: "2001:db8::5", interfaceName: "LAN", cidr: null, isPrivate: false, family: "IPv6" };

/** Render the real tab with deterministic hooks; only external APIs and visual primitives are replaced. */
async function createTab(t, addresses, host = "0.0.0.0") {
	const hooks = quickMessageHookHost();
	const qrUrls = [];
	let status = { running: true, host, port: 8765, token: "test-token", requiresAuth: true };
	const element = (type, props) => ({ type, props });
	const { WebTab } = loadTsCommonJs("src/renderer/src/components/app/settings/WebTab.tsx", {
		stubs: {
			react: { ...hooks.react, memo: (component) => component, useMemo: (factory, deps) => hooks.react.useCallback(factory, deps)() },
			"react/jsx-runtime": { jsx: element, jsxs: element },
			qrcode: {
				toDataURL: async (url) => {
					qrUrls.push(url);
					return "data:image/png;base64,test";
				},
			},
			"lucide-react": { Check: "Check", Copy: "Copy", RotateCw: "RotateCw" },
			"../../../i18n": { t: (key) => key },
			"../../../desktopApi": { desktopApi: { app: { networkAddresses: async () => addresses }, settings: { webServiceStatus: async () => status } } },
			"../../ui-shadcn/button": { Button: "Button" },
			"../../ui-shadcn/input": { Input: "Input" },
			"../../ui-shadcn/label": { Label: "Label" },
			"../../ui-shadcn/switch": { Switch: "Switch" },
			"../../ui-shadcn/select": { Select: "Select", SelectContent: "SelectContent", SelectItem: "SelectItem", SelectTrigger: "SelectTrigger", SelectValue: "SelectValue" },
			"./SettingsStorageTab": { SettingsSection: "SettingsSection" },
			"./SettingRows": { SettingRow: "SettingRow", SettingSwitchRow: "SettingSwitchRow", SettingBox: "SettingBox" },
			// 外网访问面板整块 stub 掉：测试只关心地址选择逻辑，且其真实依赖链会拉进
			// ui-shadcn/dialog（@/ 别名 helper 不解析）；cn 只服务类名合并，地址断言不依赖返回值
			"./WebRemoteAccessSection": { WebRemoteAccessSection: () => null },
			"../../../lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
		},
		globals: { window: { clearTimeout, setTimeout } },
	});
	const props = {
		draft: { webServiceEnabled: true, webServiceHost: host, webServicePort: 8765, webServiceRequiresAuth: true },
		updateDraft: () => {},
		webServiceChanging: false,
		onOpenWebService: () => {},
		onRestartWebService: () => {},
		resetKey: 0,
	};
	const render = () => hooks.render(() => WebTab(props));
	const settle = async () => {
		render();
		await new Promise(setImmediate);
		return render();
	};
	t.after(() => hooks.unmount());
	return {
		props,
		render,
		settle,
		qrUrls,
		setHost: (next) => {
			status = { ...status, host: next };
		},
		tree: await settle(),
	};
}

function nodes(tree, type) {
	if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, type));
	if (!tree || typeof tree !== "object") return [];
	return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}

function choices(tree) {
	// 令牌有效期等新增 Select 的 value 是纯数字时长；地址 value 一定含 . 或 :（IPv4/IPv6）
	return nodes(tree, "SelectItem")
		.map((node) => node.props.value)
		.filter((v) => v.includes(".") || v.includes(":"));
}

// 令牌有效期 Select 排在地址 Select 之前：按「选项里含地址形态 value」定位地址 Select
function addressSelectOf(tree) {
	return nodes(tree, "Select").find((node) => choices([node]).length > 0);
}

test("IPv4 wildcard binding never advertises IPv6 choices or QR URLs", async (t) => {
	const tab = await createTab(t, [ipv6]);
	assert.deepEqual(tab.qrUrls, [], "an IPv4 listener must not produce an unreachable IPv6 QR code");
	assert.deepEqual(choices(tab.tree), []);
});

test("IPv4 wildcard uses live status, not the unsaved host draft", async (t) => {
	const tab = await createTab(t, [ipv4, ipv6]);
	tab.props.draft.webServiceHost = "::";
	assert.deepEqual(choices(tab.render()), [ipv4.address]);
	assert.equal(tab.qrUrls.at(-1), "http://192.168.1.5:8765?token=test-token");
});

test("changing the live binding discards an incompatible selected address", async (t) => {
	const tab = await createTab(t, [ipv4, ipv6], "::");
	const addressSelect = addressSelectOf(tab.tree);
	addressSelect.props.onValueChange(ipv6.address);
	await tab.settle();
	assert.equal(tab.qrUrls.at(-1), "http://[2001:db8::5]:8765?token=test-token");
	tab.setHost("0.0.0.0");
	tab.props.webServiceChanging = true;
	const tree = await tab.settle();
	assert.deepEqual(choices(tree), [ipv4.address]);
	assert.equal(addressSelectOf(tree).props.value, ipv4.address);
	assert.equal(tab.qrUrls.at(-1), "http://192.168.1.5:8765?token=test-token");
});

test("a specific binding advertises only that interface", async (t) => {
	const tab = await createTab(t, [otherIpv4, ipv4, ipv6], ipv4.address);
	assert.deepEqual(choices(tab.tree), [ipv4.address]);
	assert.equal(tab.qrUrls.at(-1), "http://192.168.1.5:8765?token=test-token");
});

test("loopback-only binding does not advertise LAN addresses", async (t) => {
	const tab = await createTab(t, [ipv4, ipv6], "127.0.0.1");
	assert.deepEqual(choices(tab.tree), []);
	assert.deepEqual(tab.qrUrls, []);
});
