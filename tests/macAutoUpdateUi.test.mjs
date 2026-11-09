import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Render the real card against a host capability snapshot, without opening dialogs. */
function renderCard(deliveryMode, phase = "ready") {
	const snapshot = deliveryMode ? { deliveryMode, autoDownload: false, app: { hasUpdate: true, latestVersion: "0.12.1", download: { phase, version: "0.12.1" } } } : null;
	const { AppUpdateCard } = loadTsCommonJs("src/renderer/src/components/app/settings/AppUpdateCard.tsx", {
		stubs: {
			jotai: { useAtomValue: () => snapshot },
			"../../../atoms/update-atoms": { updateStatusAtom: {} },
			"../../../desktopApi": { desktopApi: {} },
			"../../../i18n": { t: (key) => key },
			"./ChangelogDialog": { ChangelogDialog: () => null },
			"./ChannelSwitchDialog": { ChannelSwitchDialog: () => null },
		},
	});
	const html = renderToStaticMarkup(createElement(AppUpdateCard, { appVersion: "0.12.0", platform: "darwin", channel: "stable", buildOrigin: "release", releasesUrl: "https://github.com/ayuayue/PiDeck/releases", checking: false, onCheckUpdate() {}, onDownloadUpdate() {}, onInstallUpdate() {} }));
	return html;
}

const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");

/** Keep unrelated settings panels out of this renderer test, while using real switch rows. */
function renderDevTab(deliveryMode) {
	const statusAtom = {};
	const channelAtom = {};
	const { DevTab } = loadTsCommonJs("src/renderer/src/components/app/settings/DevTab.tsx", {
		stubs: {
			jotai: { useAtomValue: (atom) => (atom === statusAtom ? { deliveryMode, deliveryReason: deliveryMode === "manual" ? "mac-unsigned" : "automatic" } : { channel: "stable" }) },
			"../../../atoms/update-atoms": { updateStatusAtom: statusAtom },
			"../../../atoms/channelSwitchAtoms": { updateChannelInfoAtom: channelAtom },
			"../../../desktopApi": { desktopApi: {} },
			"../../../i18n": { t: (key) => key },
			"./SettingsStorageTab": { SettingsSection: ({ children }) => children },
			"./AppUpdateCard": { AppUpdateCard: () => null },
			"./UpdateSourceSetting": { UpdateSourceSetting: () => null },
			"./DiagnosticsPanel": { DiagnosticsPanel: () => null },
			"./CatalogSection": { CatalogSection: () => null },
			"./DshRunnerNodeRow": { DshRunnerNodeRow: () => null },
			"../PiCommandSourcePanel": { PiCommandSourcePanel: () => null },
			"./PiChangelogDialog": { PiChangelogDialog: () => null },
		},
	});
	return renderToStaticMarkup(createElement(DevTab, { draft: createDefaultAppSettings(), updateDraft() {}, isDirty: () => false, appInfo: { platform: "darwin", version: "0.12.0" }, piStatus: null, piUpdateCheck: null, piUpdateResult: null }));
}

test("signed Mac settings expose automatic downloading, while unsigned Mac settings explain manual delivery", () => {
	const automatic = renderDevTab("automatic");
	assert.match(automatic, /settings\.autoDownloadUpdates/);
	assert.doesNotMatch(automatic, /settings\.macManualUpdateDesc/);
	const manual = renderDevTab("manual");
	assert.match(manual, /settings\.macManualUpdateDesc/);
	assert.doesNotMatch(manual, /settings\.autoDownloadUpdates/);
});

test("a signed Mac with an automatic host snapshot offers restart and install", () => {
	const html = renderCard("automatic");
	assert.match(html, /settings\.updateInstallNow/);
	assert.match(html, /settings\.updateReadyToInstall/);
	assert.doesNotMatch(html, /settings\.updateOpenInstaller/);
});

test("automatic Mac delivery offers download when automatic downloading is disabled", () => {
	assert.match(renderCard("automatic", "available"), /settings\.updateDownloadNow/);
});

test("an unsigned Mac with a manual host snapshot still opens the downloaded installer", () => {
	const html = renderCard("manual");
	assert.match(html, /settings\.updateOpenInstaller/);
	assert.doesNotMatch(html, /settings\.updateInstallNow/);
});
