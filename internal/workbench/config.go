//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"time"
)

// workspaceCfg is one project folder.
type workspaceCfg struct {
	Path      string    `json:"path"`
	Name      string    `json:"name,omitempty"`
	Expanded  bool      `json:"expanded"`
	Group     string    `json:"group,omitempty"`
	Pinned    bool      `json:"pinned,omitempty"`
	Added     time.Time `json:"added,omitempty"`
	ACPPreset string    `json:"acpPreset,omitempty"`
	// Chat marks the built-in chat folder, which is not a project the
	// user added but the app's own place for conversations.
	Chat bool `json:"chat,omitempty"`
	// Target is where its agents run: "" here, "wsl:<distro>",
	// "ssh:<host>".
	Target string `json:"target,omitempty"`
}

// modelChoice remembers a provider/model across runs.
type modelChoice struct {
	Provider string `json:"provider,omitempty"`
	ID       string `json:"id,omitempty"`
}

// windowCfg is where the window was and how big, and whether it was
// maximized. A zero W and H keep the default size.
type windowCfg struct {
	X         float64 `json:"x,omitempty"`
	Y         float64 `json:"y,omitempty"`
	W         float64 `json:"w,omitempty"`
	H         float64 `json:"h,omitempty"`
	Maximized bool    `json:"maximized,omitempty"`
}

// config is everything the app restores at startup.
type config struct {
	Version     int            `json:"version"`
	Workspaces  []workspaceCfg `json:"workspaces"`
	LastSession string         `json:"lastSession,omitempty"`
	Tabs        []string       `json:"tabs,omitempty"`
	Theme       string         `json:"theme,omitempty"` // system, light, dark
	// Branding is shared by the rail, welcome and about views. The custom
	// image is inline data so settings backups carry it with them.
	LogoStyle       string            `json:"logoStyle,omitempty"` // pi-tui (default), classic, custom
	LogoCustomImage string            `json:"logoCustomImage,omitempty"`
	AppDisplayName  string            `json:"appDisplayName,omitempty"`
	SidebarOpen     bool              `json:"sidebarOpen"`
	DrawerOpen      bool              `json:"drawerOpen"`
	Model           modelChoice       `json:"model"`
	Thinking        string            `json:"thinking,omitempty"`
	Titles          map[string]string `json:"titles,omitempty"`
	// Pinned are the sessions kept at the top of the rail, and FavModels
	// the "provider/id" of the models offered first.
	Pinned    []string `json:"pinned,omitempty"`
	FavModels []string `json:"favModels,omitempty"`
	// ProviderOrder is the order suppliers are listed in, pinned ones
	// first; providers it does not name follow alphabetically.
	ProviderOrder []string `json:"providerOrder,omitempty"`
	// ScanPi lists pi's own sessions under the projects that own them, and
	// ScanAll lists every folder pi has ever run in.
	ScanPi  bool `json:"scanPi"`
	ScanAll bool `json:"scanAll"`
	// SessionSort orders a project's sessions: "updated" (default) or
	// "name".
	SessionSort string `json:"sessionSort,omitempty"`
	// ProjectSort orders the rail's projects: "recent" (default),
	// "created", "title", or "manual" for the stored order. An empty value
	// is the older spelling of the default.
	ProjectSort string `json:"projectSort,omitempty"`
	// Window is the window's last frame: where it was, how big, maximized.
	Window windowCfg `json:"window"`
	// RailWidth and DrawerWidth are the two side panels' widths in points;
	// 0 keeps their defaults.
	RailWidth   float64 `json:"railWidth,omitempty"`
	DrawerWidth float64 `json:"drawerWidth,omitempty"`
	// DrawerTab is the right panel's last tab, SettingsTab the settings
	// section last open, and ImportSource the import dialog's last tab.
	DrawerTab    string `json:"drawerTab,omitempty"`
	SettingsTab  string `json:"settingsTab,omitempty"`
	ImportSource string `json:"importSource,omitempty"`
	// TerminalOpen and TerminalHeight restore the bottom terminal panel.
	TerminalOpen   bool    `json:"terminalOpen,omitempty"`
	TerminalHeight float64 `json:"terminalHeight,omitempty"`
	// ChatWidthPct is the transcript and composer's share of the window
	// width, 50 to 90; 0 keeps the default of 60.
	ChatWidthPct int `json:"chatWidthPct,omitempty"`
	// ChatWidth was that width in points before it became a percentage.
	// It is read only to migrate an older file and is cleared on load.
	ChatWidth int `json:"chatWidth,omitempty"`
	// Remote is the phone server: whether it listens, its port and token,
	// and the EasyTier address when its CLI cannot be read.
	RemoteEnabled    bool   `json:"remoteEnabled,omitempty"`
	RemotePort       int    `json:"remotePort,omitempty"`
	RemoteToken      string `json:"remoteToken,omitempty"`
	RemoteEasyTierIP string `json:"remoteEasyTierIP,omitempty"`
	// RemoteRelay is the outbound tunnel that lets a phone reach this
	// desktop without a VPN. Env and Key identify it on the relay; the
	// certificate lives beside the config.
	RemoteRelay    bool   `json:"remoteRelay,omitempty"`
	RemoteRelayURL string `json:"remoteRelayURL,omitempty"`
	RemoteRelayEnv string `json:"remoteRelayEnv,omitempty"`
	RemoteRelayKey string `json:"remoteRelayKey,omitempty"`
	// WatchaUserID identifies this installation to the tip proxy, which
	// holds the platform key. It is a random id, created on first use.
	WatchaUserID string `json:"watchaUserId,omitempty"`
	// RemotePublicURL is an address the user forwards to this desktop
	// themselves, such as a Cloudflare Tunnel or a reverse proxy.
	RemotePublicURL string `json:"remotePublicURL,omitempty"`
	// DisabledPlugins are the plugin ids the user turned off; everything
	// else under plugins/ runs.
	DisabledPlugins []string `json:"disabledPlugins,omitempty"`
	// PluginSettings holds the values of settings plugins declare, by
	// "pluginID/key".
	PluginSettings map[string]string `json:"pluginSettings,omitempty"`
	// SessionPersonas binds a session to an agent by its id.
	SessionPersonas map[string]string `json:"sessionPersonas,omitempty"`
	// ForkParents maps a fork to the session it branched from.
	ForkParents map[string]string `json:"forkParents,omitempty"`
	// PluginIndexURL and PromptIndexURL are the markets' last links.
	PluginIndexURL string `json:"pluginIndexUrl,omitempty"`
	PromptIndexURL string `json:"promptIndexUrl,omitempty"`
	SkillIndexURL  string `json:"skillIndexUrl,omitempty"`
	// TrustedProjects are the projects the user allowed agents to work
	// in, keyed "target|path". A project added at runtime starts
	// untrusted; configs from before trust existed are migrated as trusted.
	TrustedProjects []string `json:"trustedProjects,omitempty"`
	// CrashSeen is the crash log the user was last told about, so the
	// notice shows once per crash.
	CrashSeen string `json:"crashSeen,omitempty"`
	// ImageProvider, ImageModel and ImageSize remember the image
	// generator's last choices.
	ImageProvider string `json:"imageProvider,omitempty"`
	ImageModel    string `json:"imageModel,omitempty"`
	ImageSize     string `json:"imageSize,omitempty"`
	ImageCount    int    `json:"imageCount,omitempty"`
	// VisionProvider and VisionModel remember the vision bridge's last
	// choices.
	VisionProvider string `json:"visionProvider,omitempty"`
	VisionModel    string `json:"visionModel,omitempty"`
	// Balances are custom balance endpoints, by provider id, for
	// providers the app does not know.
	Balances map[string]balanceSpec `json:"balances,omitempty"`
	// ProxyApp routes the app's own HTTP calls, ProxyAgent the agent
	// processes it starts, and ProxyBypass is their shared no-proxy list.
	ProxyApp    string `json:"proxyApp,omitempty"`
	ProxyAgent  string `json:"proxyAgent,omitempty"`
	ProxyBypass string `json:"proxyBypass,omitempty"`
	// Keybindings replaces a command's default key, by command id. An
	// empty key removes the binding.
	Keybindings map[string]string `json:"keybindings,omitempty"`
	// CloseToTray keeps the app running in the tray when its window is
	// closed. NotifyOnDone posts a desktop notification when a turn
	// finishes, and NotifyOnlyHidden keeps it quiet while the window
	// shows.
	CloseToTray      bool `json:"closeToTray"`
	NotifyOnDone     bool `json:"notifyOnDone"`
	NotifyOnlyHidden bool `json:"notifyOnlyHidden"`
	// SoundEnabled plays a short sound when a turn finishes, fails or
	// waits for an answer, and SoundOnlyHidden keeps it quiet while the
	// window shows. SoundDone, SoundError and SoundWaiting name the sound
	// of each moment: empty for its default, a built-in name, or "custom"
	// for SoundCustom's file in sounds/. SoundVolume is a percentage, and
	// nil plays at 70.
	SoundEnabled    bool   `json:"soundEnabled"`
	SoundOnlyHidden bool   `json:"soundOnlyHidden"`
	SoundDone       string `json:"soundDone,omitempty"`
	SoundError      string `json:"soundError,omitempty"`
	SoundWaiting    string `json:"soundWaiting,omitempty"`
	SoundCustom     string `json:"soundCustom,omitempty"`
	SoundVolume     *int   `json:"soundVolume,omitempty"`
	// Language is the interface's language: "" follows the system, else
	// one of supportedLanguages.
	Language string `json:"language,omitempty"`
	// Feishu posts a finished turn to a group bot. The webhook is the
	// bot's URL; Secret is its signing key, when it has one. Inbound
	// takes the bot's event callback on /api/feishu, verified by Token,
	// and Reply sends the answer back to the group.
	FeishuEnabled     bool   `json:"feishuEnabled,omitempty"`
	FeishuWebhook     string `json:"feishuWebhook,omitempty"`
	FeishuSecret      string `json:"feishuSecret,omitempty"`
	FeishuInbound     bool   `json:"feishuInbound,omitempty"`
	FeishuVerifyToken string `json:"feishuVerifyToken,omitempty"`
	FeishuReply       bool   `json:"feishuReply,omitempty"`
	// RecentCommands are the palette commands used last, newest first.
	RecentCommands []string `json:"recentCommands,omitempty"`
	// RecentSearches are the last queries the search dialog opened.
	RecentSearches []string `json:"recentSearches,omitempty"`
	// RecentFiles are the files the editor opened last, newest first.
	RecentFiles []string `json:"recentFiles,omitempty"`
	// Archived are the sessions hidden from the rail but kept on disk.
	Archived []string `json:"archived,omitempty"`
	// ShowArchived lists them again, marked as archived.
	ShowArchived bool `json:"showArchived,omitempty"`
	// EditorWrap soft-wraps long lines in the built-in editor.
	EditorWrap bool `json:"editorWrap,omitempty"`
	// TerminalFont is the terminal's text size; 0 keeps the default.
	TerminalFont float64 `json:"terminalFont,omitempty"`
	// EditorFont is the editor's text size; 0 keeps the default.
	EditorFont int `json:"editorFont,omitempty"`
	// ChatFont is the transcript's text size in points, and ChatLine its
	// line height as a multiple of it; 0 keeps the defaults. InputFont is
	// the composer's text size; 0 follows ChatFont.
	ChatFont  float64 `json:"chatFont,omitempty"`
	ChatLine  float64 `json:"chatLine,omitempty"`
	InputFont float64 `json:"inputFont,omitempty"`
	// UIFont names an installed font family for the interface; empty follows the theme.
	UIFont string `json:"uiFont,omitempty"`
	// MonoFont names an installed font family for the editor; empty uses the system's monospaced font.
	MonoFont string `json:"monoFont,omitempty"`
	// ToolModels gives each AI tool its own provider and model.
	ToolModels map[string]toolModelCfg `json:"toolModels,omitempty"`
	// BackgroundImage is a local picture behind the app; empty uses none.
	BackgroundImage string `json:"backgroundImage,omitempty"`
	// BackgroundOpacity is how much of the picture shows, 0 to 1; nil reads 0.8.
	BackgroundOpacity *float64 `json:"backgroundOpacity,omitempty"`
	// PetEnabled shows the desktop pet window.
	PetEnabled bool `json:"petEnabled,omitempty"`
	// TelemetryEnabled is the anonymous daily heartbeat; nil keeps it on,
	// as PiDeck ships it. TelemetryInstallID is the anonymous id it counts,
	// and TelemetryLastHeartbeatDate the local day it last went out.
	TelemetryEnabled           *bool  `json:"telemetryEnabled,omitempty"`
	TelemetryInstallID         string `json:"telemetryInstallId,omitempty"`
	TelemetryLastHeartbeatDate string `json:"telemetryLastHeartbeatDate,omitempty"`
	// EditorCommand opens files outside the app; empty detects one.
	EditorCommand string `json:"editorCommand,omitempty"`
}
