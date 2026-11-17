//go:build !js && !android && !ios

package main

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
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
	Version     int               `json:"version"`
	Workspaces  []workspaceCfg    `json:"workspaces"`
	LastSession string            `json:"lastSession,omitempty"`
	Tabs        []string          `json:"tabs,omitempty"`
	Theme       string            `json:"theme,omitempty"` // system, light, dark
	SidebarOpen bool              `json:"sidebarOpen"`
	DrawerOpen  bool              `json:"drawerOpen"`
	Model       modelChoice       `json:"model"`
	Thinking    string            `json:"thinking,omitempty"`
	Titles      map[string]string `json:"titles,omitempty"`
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
	// ProjectSort orders the rail's projects: "" or "manual" keeps the
	// stored order; "recent", "created" and "title" sort them.
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
	// ChatWidth is the reading width of the transcript and composer, in
	// points; 0 keeps the kit's default.
	ChatWidth int `json:"chatWidth,omitempty"`
	// Remote is the phone server: whether it listens, its port and token,
	// and the EasyTier address when its CLI cannot be read.
	RemoteEnabled    bool   `json:"remoteEnabled,omitempty"`
	RemotePort       int    `json:"remotePort,omitempty"`
	RemoteToken      string `json:"remoteToken,omitempty"`
	RemoteEasyTierIP string `json:"remoteEasyTierIP,omitempty"`
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
	// Language is the interface's language: "" follows the system, else
	// zh-CN, zh-TW or en-US.
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

// store holds the config file and the session directory.
type store struct {
	dir      string // app data
	sessions string // private pi session directory
	path     string // config.json
	mu       sync.Mutex
	c        *config
	// metas caches the listing of each session file, keyed by path, so a
	// rescan only reads files whose size or modification time changed.
	metas map[string]metaCacheEntry
	// parses counts the session files actually read, and consumed the bytes
	// those reads took, which lets a test see the cache and the tail reads
	// doing their work.
	parses   int
	consumed int64
	// metaPath is where the listings are kept between runs, so a start
	// reads no session file at all. metaDirty marks a change not yet
	// written, and metaWriteMu keeps two writers off one temporary file.
	metaPath    string
	metaDirty   bool
	metaWriteMu sync.Mutex
}

// metaCacheEntry is one file's cached listing. Partial marks a listing
// that read only the session header, because its project was off screen.
type metaCacheEntry struct {
	Size    int64       `json:"size"`
	ModTime time.Time   `json:"mtime"`
	Meta    sessionMeta `json:"meta"`
	OK      bool        `json:"ok"`
	Partial bool        `json:"partial,omitempty"`
	// Tail is how much of the file the listing covers, so an appended file
	// is read from there instead of from the top.
	Tail parsedTail `json:"tail,omitempty"`
}

func newStore(dataDir string) (*store, error) {
	s := &store{
		dir:      dataDir,
		sessions: filepath.Join(dataDir, "sessions"),
		path:     filepath.Join(dataDir, "config.json"),
		metaPath: filepath.Join(dataDir, "session-meta-cache.json"),
		c: &config{Version: configVersion, SidebarOpen: true, Theme: "system", Titles: map[string]string{}, ScanPi: true,
			CloseToTray: true, NotifyOnDone: true, NotifyOnlyHidden: true},
	}
	if err := os.MkdirAll(s.sessions, 0o755); err != nil {
		return nil, err
	}
	s.loadMetaCache()
	if raw, err := os.ReadFile(s.path); err == nil {
		var c config
		if json.Unmarshal(raw, &c) == nil {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			changed := migrateConfig(&c, raw)
			s.c = &c
			if changed {
				_ = s.save()
			}
		}
	}
	return s, nil
}

// configVersion is the shape of config.json this build writes. A file
// from an older build is migrated on load and written back once.
const configVersion = 2

// migrateConfig brings an older config up to date and repairs values a
// hand-edited file may have got wrong. It reports whether anything
// changed, so the store writes the file back once.
func migrateConfig(c *config, raw []byte) bool {
	changed := false
	if c.Version < 1 {
		// A config written before these fields existed reads pi's own
		// sessions under their projects: it is the useful default.
		if !bytes.Contains(raw, []byte(`"scanPi"`)) && !bytes.Contains(raw, []byte(`"scanAll"`)) {
			c.ScanPi = true
		}
		// Older configs did not know the tray or notifications: keep
		// them on, as a fresh install has them.
		if !bytes.Contains(raw, []byte(`"closeToTray"`)) {
			c.CloseToTray = true
		}
		if !bytes.Contains(raw, []byte(`"notifyOnDone"`)) {
			c.NotifyOnDone = true
		}
		if !bytes.Contains(raw, []byte(`"notifyOnlyHidden"`)) {
			c.NotifyOnlyHidden = true
		}
		c.Version = 1
		changed = true
	}
	if c.Version < 2 {
		// Projects that existed before trust was introduced are trusted;
		// only folders added later need confirmation.
		seen := map[string]bool{}
		for _, key := range c.TrustedProjects {
			seen[key] = true
		}
		for _, w := range c.Workspaces {
			t := parseTarget(w.Target)
			key := t.key() + "|" + cleanTargetPath(t, w.Path)
			if w.Path != "" && !seen[key] {
				c.TrustedProjects = append(c.TrustedProjects, key)
				seen[key] = true
			}
		}
		c.Version = 2
		changed = true
	}
	return normalizeConfig(c) || changed
}

// normalizeConfig resets values a hand-edited file could have got wrong:
// unknown choices, out-of-range sizes, and duplicate projects or tabs.
func normalizeConfig(c *config) bool {
	changed := false
	trim := func(s *string) {
		if v := strings.TrimSpace(*s); v != *s {
			*s = v
			changed = true
		}
	}
	trim(&c.SessionSort)
	trim(&c.ProjectSort)
	trim(&c.Language)
	trim(&c.ProxyApp)
	trim(&c.ProxyAgent)
	trim(&c.ProxyBypass)
	trim(&c.Theme)
	switch c.Theme {
	case "classic":
		c.Theme = "system"
		changed = true
	case "warm-beige":
		// 暖阳米与羊皮纸太接近，合并到羊皮纸。
		c.Theme = "parchment"
		changed = true
	}
	switch c.SessionSort {
	case "", "updated", "name":
	default:
		c.SessionSort = ""
		changed = true
	}
	switch c.ProjectSort {
	case "", "manual", "recent", "created", "title":
	default:
		c.ProjectSort = ""
		changed = true
	}
	switch c.Language {
	case "", langZhCN, langZhTW, langEnUS:
	default:
		c.Language = ""
		changed = true
	}
	if c.TerminalHeight != 0 && (c.TerminalHeight < 120 || c.TerminalHeight > 1200) {
		c.TerminalHeight = 0
		changed = true
	}
	if c.ChatWidth != 0 {
		w := c.ChatWidth
		if w < chatWidthMin {
			w = chatWidthMin
		}
		if w > chatWidthMax {
			w = chatWidthMax
		}
		if w != c.ChatWidth {
			c.ChatWidth = w
			changed = true
		}
	}
	switch c.ImageCount {
	case 0, 1, 2, 4:
	default:
		c.ImageCount = 0
		changed = true
	}
	for id, spec := range c.Balances {
		spec.URL = strings.TrimSpace(spec.URL)
		spec.Path = strings.TrimSpace(spec.Path)
		spec.Currency = strings.TrimSpace(spec.Currency)
		if len(spec.URL) > 500 {
			spec.URL = spec.URL[:500]
			changed = true
		}
		if len(spec.Path) > 200 {
			spec.Path = spec.Path[:200]
			changed = true
		}
		if id == "" || (spec.URL == "" && spec.Path == "" && spec.Currency == "") {
			delete(c.Balances, id)
			changed = true
			continue
		}
		c.Balances[id] = spec
	}
	if c.TerminalFont != 0 && (c.TerminalFont < 8 || c.TerminalFont > 20) {
		c.TerminalFont = 0
		changed = true
	}
	if c.EditorFont != 0 && (c.EditorFont < 11 || c.EditorFont > 20) {
		c.EditorFont = 0
		changed = true
	}
	if c.ChatFont != 0 && (c.ChatFont < chatFontMin || c.ChatFont > chatFontMax) {
		c.ChatFont = 0
		changed = true
	}
	if c.ChatLine != 0 && (c.ChatLine < chatLineMin || c.ChatLine > chatLineMax) {
		c.ChatLine = 0
		changed = true
	}
	if c.InputFont != 0 && (c.InputFont < chatFontMin || c.InputFont > chatFontMax) {
		c.InputFont = 0
		changed = true
	}

	if c.RemotePort != 0 && (c.RemotePort < 1 || c.RemotePort > 65535) {
		c.RemotePort = 0
		changed = true
	}
	seenCmd := map[string]bool{}
	var cmds []string
	for _, id := range c.RecentCommands {
		id = strings.TrimSpace(id)
		if id == "" || seenCmd[id] {
			continue
		}
		seenCmd[id] = true
		cmds = append(cmds, id)
		if len(cmds) >= 8 {
			break
		}
	}
	if len(cmds) != len(c.RecentCommands) {
		c.RecentCommands = cmds
		changed = true
	}
	seenSearch := map[string]bool{}
	var searches []string
	for _, q := range c.RecentSearches {
		q = strings.TrimSpace(q)
		if q == "" || seenSearch[q] {
			continue
		}
		seenSearch[q] = true
		searches = append(searches, q)
		if len(searches) >= 8 {
			break
		}
	}
	if len(searches) != len(c.RecentSearches) {
		c.RecentSearches = searches
		changed = true
	}
	seenRecentFile := map[string]bool{}
	var recentFiles []string
	for _, p := range c.RecentFiles {
		p = strings.TrimSpace(p)
		if p == "" || seenRecentFile[p] {
			continue
		}
		seenRecentFile[p] = true
		recentFiles = append(recentFiles, p)
		if len(recentFiles) >= recentFileMax {
			break
		}
	}
	if len(recentFiles) != len(c.RecentFiles) {
		c.RecentFiles = recentFiles
		changed = true
	}
	seenArchived := map[string]bool{}
	var archived []string
	for _, id := range c.Archived {
		id = strings.TrimSpace(id)
		if id == "" || seenArchived[id] {
			continue
		}
		seenArchived[id] = true
		archived = append(archived, id)
		if len(archived) >= 500 {
			break
		}
	}
	if len(archived) != len(c.Archived) {
		c.Archived = archived
		changed = true
	}
	seen := map[string]bool{}
	var projects []workspaceCfg
	for _, w := range c.Workspaces {
		w.Path = strings.TrimSpace(w.Path)
		w.Target = strings.TrimSpace(w.Target)
		key := w.Target + "|" + w.Path
		if w.Path == "" || seen[key] {
			changed = true
			continue
		}
		seen[key] = true
		projects = append(projects, w)
	}
	if len(projects) != len(c.Workspaces) {
		c.Workspaces = projects
	}
	seenTab := map[string]bool{}
	var tabs []string
	for _, id := range c.Tabs {
		id = strings.TrimSpace(id)
		if id == "" || seenTab[id] {
			changed = true
			continue
		}
		seenTab[id] = true
		tabs = append(tabs, id)
	}
	if len(tabs) != len(c.Tabs) {
		c.Tabs = tabs
	}
	return changed
}

// save writes the config as it is now.
func (s *store) save() error {
	s.mu.Lock()
	raw, err := json.MarshalIndent(s.c, "", "  ")
	path := s.path
	s.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// reload rereads config.json after something outside the store wrote it,
// such as a settings backup.
func (s *store) reload() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		return err
	}
	if c.Titles == nil {
		c.Titles = map[string]string{}
	}
	migrateConfig(&c, raw)
	s.mu.Lock()
	s.c = &c
	s.mu.Unlock()
	return nil
}

// config returns a copy safe to read on the UI thread.
func (s *store) config() config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := *s.c
	c.Workspaces = append([]workspaceCfg(nil), s.c.Workspaces...)
	c.Tabs = append([]string(nil), s.c.Tabs...)
	c.Pinned = append([]string(nil), s.c.Pinned...)
	c.FavModels = append([]string(nil), s.c.FavModels...)
	c.ProviderOrder = append([]string(nil), s.c.ProviderOrder...)
	c.DisabledPlugins = append([]string(nil), s.c.DisabledPlugins...)
	c.Keybindings = make(map[string]string, len(s.c.Keybindings))
	for k, v := range s.c.Keybindings {
		c.Keybindings[k] = v
	}
	c.Titles = make(map[string]string, len(s.c.Titles))
	for k, v := range s.c.Titles {
		c.Titles[k] = v
	}
	c.TrustedProjects = append([]string(nil), s.c.TrustedProjects...)
	c.RecentFiles = append([]string(nil), s.c.RecentFiles...)
	c.Archived = append([]string(nil), s.c.Archived...)
	c.ToolModels = make(map[string]toolModelCfg, len(s.c.ToolModels))
	for k, v := range s.c.ToolModels {
		c.ToolModels[k] = v
	}
	if s.c.BackgroundOpacity != nil {
		v := *s.c.BackgroundOpacity
		c.BackgroundOpacity = &v
	}
	c.PluginSettings = make(map[string]string, len(s.c.PluginSettings))
	for k, v := range s.c.PluginSettings {
		c.PluginSettings[k] = v
	}
	c.SessionPersonas = make(map[string]string, len(s.c.SessionPersonas))
	for k, v := range s.c.SessionPersonas {
		c.SessionPersonas[k] = v
	}
	c.RecentCommands = append([]string(nil), s.c.RecentCommands...)
	c.RecentSearches = append([]string(nil), s.c.RecentSearches...)
	c.ForkParents = make(map[string]string, len(s.c.ForkParents))
	for k, v := range s.c.ForkParents {
		c.ForkParents[k] = v
	}
	c.Balances = make(map[string]balanceSpec, len(s.c.Balances))
	for k, v := range s.c.Balances {
		c.Balances[k] = v
	}
	return c
}

// edit changes the config and writes it.
func (s *store) edit(fn func(*config)) {
	s.mu.Lock()
	fn(s.c)
	s.mu.Unlock()
	_ = s.save()
}

// sessionMeta is a session as the sidebar and tabs need it before its
// process starts. It is what session-meta-cache.json keeps, so its fields
// are tagged and File travels as the map key instead.
type sessionMeta struct {
	ID      string    `json:"id"`
	Cwd     string    `json:"cwd"`
	File    string    `json:"-"`
	Title   string    `json:"title,omitempty"`
	Updated time.Time `json:"updated"`
	Count   int       `json:"count,omitempty"`
	Target  string    `json:"target,omitempty"`
	// External marks a session in pi's own store, which the app opens in
	// place rather than owning.
	External bool `json:"-"`
}

// metaCacheVersion is the shape of session-meta-cache.json. Bump it when a
// field means something else, and every file is read again once.
const metaCacheVersion = 2

// metaCacheMax bounds the listings kept, as the scan itself is bounded.
const metaCacheMax = 8000

// metaCacheFile is what session-meta-cache.json holds.
type metaCacheFile struct {
	Version int                       `json:"version"`
	Entries map[string]metaCacheEntry `json:"entries"`
}

// metaResult is one file's listing, or that it has none.
type metaResult struct {
	meta sessionMeta
	ok   bool
}

// loadMetaCache restores the listings the last run left behind, so a
// warm start reads no session file at all. A missing, corrupt or older
// cache is simply a cold start.
func (s *store) loadMetaCache() {
	raw, err := os.ReadFile(s.metaPath)
	if err != nil {
		return
	}
	var f metaCacheFile
	if json.Unmarshal(raw, &f) != nil || f.Version != metaCacheVersion || len(f.Entries) == 0 || len(f.Entries) > metaCacheMax {
		return
	}
	for path, e := range f.Entries {
		if e.ModTime.IsZero() {
			delete(f.Entries, path)
			continue
		}
		e.Meta.File = path
		f.Entries[path] = e
	}
	s.mu.Lock()
	s.metas = f.Entries
	s.mu.Unlock()
}

// writeMetaCache writes the listings as they are now, atomically, so a
// half-written cache is never read.
func (s *store) writeMetaCache() {
	s.metaWriteMu.Lock()
	defer s.metaWriteMu.Unlock()
	s.mu.Lock()
	f := metaCacheFile{Version: metaCacheVersion, Entries: make(map[string]metaCacheEntry, len(s.metas))}
	for path, e := range s.metas {
		f.Entries[path] = e
	}
	s.metaDirty = false
	s.mu.Unlock()
	raw, err := json.Marshal(f)
	if err != nil {
		return
	}
	tmp := s.metaPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, s.metaPath)
}

// saveMetaCache writes the listings when a scan changed them, so the next
// start reads no session file at all. A failed write costs one slow start.
func (s *store) saveMetaCache() {
	s.mu.Lock()
	dirty := s.metaDirty
	s.mu.Unlock()
	if dirty {
		s.writeMetaCache()
	}
}

// sessionFiles lists every session file under root.
func sessionFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files
}

// scanSessions reads the headers and names of the session files in the
// app's store, newest first.
func (s *store) scanSessions(titles map[string]string) []sessionMeta {
	files := sessionFiles(s.sessions)
	metas := s.readMetas(files, titles, nil)
	s.pruneMetas(s.sessions, files)
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	s.saveMetaCache()
	return metas
}

// scanPiSessions reads pi's own session store, keeping the sessions of the
// folders keep allows, at most limit of them. Files of other folders are
// read as far as their header only, so a large store costs what the
// projects on screen hold, not what this machine ever ran.
func (s *store) scanPiSessions(root string, titles map[string]string, keep func(cwd string) bool, limit int) []sessionMeta {
	if root == "" || filepath.Clean(root) == filepath.Clean(s.sessions) {
		return nil
	}
	files := sessionFiles(root)
	metas := s.readMetas(files, titles, keep)
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	if limit > 0 && len(metas) > limit {
		metas = metas[:limit]
	} else {
		s.pruneMetas(root, files)
	}
	for i := range metas {
		metas[i].External = true
	}
	s.saveMetaCache()
	return metas
}

// readMetas builds the listing of each file: cached ones without a read,
// the rest a few at a time, so a cold scan of a large store does not wait
// on one core.
func (s *store) readMetas(files []string, titles map[string]string, want func(cwd string) bool) []sessionMeta {
	results := make([]metaResult, len(files))
	var pending []int
	for i, path := range files {
		if r, done := s.cachedMeta(path, want); done {
			results[i] = r
			continue
		}
		pending = append(pending, i)
	}
	if len(pending) > 0 {
		workers := min(len(pending), min(runtime.GOMAXPROCS(0), 8))
		if workers < 1 {
			workers = 1
		}
		queue := make(chan int)
		var wg sync.WaitGroup
		wg.Add(workers)
		for w := 0; w < workers; w++ {
			go func() {
				defer wg.Done()
				for i := range queue {
					results[i] = s.readMetaFile(files[i], want)
				}
			}()
		}
		for _, i := range pending {
			queue <- i
		}
		close(queue)
		wg.Wait()
	}
	metas := make([]sessionMeta, 0, len(files))
	for _, r := range results {
		if !r.ok || (want != nil && !want(r.meta.Cwd)) {
			continue
		}
		metas = append(metas, applySessionTitle(r.meta, titles))
	}
	return metas
}

// cachedMeta answers a file from the cache when the cache can: an
// unchanged file needs no read, and a listing whose project is off screen
// needs not even a stat.
func (s *store) cachedMeta(path string, want func(cwd string) bool) (metaResult, bool) {
	s.mu.Lock()
	e, found := s.metas[path]
	s.mu.Unlock()
	if !found {
		return metaResult{}, false
	}
	if want != nil && e.OK && !want(e.Meta.Cwd) {
		// Off screen: nothing in this file can change that.
		return metaResult{meta: e.Meta, ok: true}, true
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != e.Size || !info.ModTime().Equal(e.ModTime) {
		return metaResult{}, false
	}
	if e.Partial && (want == nil || want(e.Meta.Cwd)) {
		// Only the header was read; its project wants the rest now.
		return metaResult{}, false
	}
	return metaResult{meta: e.Meta, ok: e.OK}, true
}

// readMetaFile reads one session file and records its listing.
func (s *store) readMetaFile(path string, want func(cwd string) bool) metaResult {
	info, err := os.Stat(path)
	if err != nil {
		return metaResult{}
	}
	s.mu.Lock()
	prev := s.metas[path]
	s.mu.Unlock()
	read := readSessionMeta(path, prev, want)
	s.mu.Lock()
	if s.metas == nil || len(s.metas) > metaCacheMax {
		s.metas = map[string]metaCacheEntry{}
	}
	s.metas[path] = metaCacheEntry{Size: info.Size(), ModTime: info.ModTime(), Meta: read.meta,
		OK: read.ok, Partial: read.partial, Tail: read.tail}
	s.parses++
	s.consumed += read.tail.Consumed - read.start
	s.metaDirty = true
	s.mu.Unlock()
	if !read.ok {
		return metaResult{}
	}
	return metaResult{meta: read.meta, ok: true}
}

// readMeta returns a session file's listing, reusing the cached one while
// the file is unchanged. Titles come from the config and are applied on
// every call, so a rename does not need a reparse.
func (s *store) readMeta(path string, titles map[string]string) (sessionMeta, bool) {
	r, done := s.cachedMeta(path, nil)
	if !done {
		r = s.readMetaFile(path, nil)
		s.saveMetaCache()
	}
	if !r.ok {
		return sessionMeta{}, false
	}
	return applySessionTitle(r.meta, titles), true
}

// pruneMetas drops the listings of files a scan no longer finds, so a
// deleted session does not stay in the cache for ever.
func (s *store) pruneMetas(root string, files []string) {
	seen := make(map[string]struct{}, len(files))
	for _, path := range files {
		seen[path] = struct{}{}
	}
	prefix := filepath.Clean(root) + string(filepath.Separator)
	s.mu.Lock()
	changed := false
	for path := range s.metas {
		if _, ok := seen[path]; ok || !strings.HasPrefix(path, prefix) {
			continue
		}
		delete(s.metas, path)
		changed = true
	}
	if changed {
		s.metaDirty = true
	}
	s.mu.Unlock()
}

// applySessionTitle puts the user's name, or a placeholder, on a listing.
func applySessionTitle(meta sessionMeta, titles map[string]string) sessionMeta {
	if t := titles[meta.ID]; t != "" {
		meta.Title = t
	} else if meta.Title == "" {
		meta.Title = "未命名会话"
	}
	return meta
}

// countSessions counts the session files without reading them, for the
// settings page, which only needs the number.
func (s *store) countSessions() int {
	n := 0
	_ = filepath.WalkDir(s.sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		n++
		return nil
	})
	return n
}

// metaRead is what reading one session file produced.
type metaRead struct {
	meta    sessionMeta
	ok      bool
	partial bool
	start   int64 // where the read began, 0 when the whole file was read
	tail    parsedTail
}

// readSessionMeta reads as much of one session file as a listing needs:
// its header always, and its messages when want accepts the folder it
// belongs to. A listing that stops at the header is partial and is read in
// full once its project is on screen.
//
// prev is what the last read of this file left behind: a file that only
// grew is read from where that one stopped, which is what keeps a start from
// re-reading a long session that was used yesterday.
func readSessionMeta(path string, prev metaCacheEntry, want func(cwd string) bool) metaRead {
	meta := sessionMeta{File: path}
	size := int64(0)
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
		meta.Updated = info.ModTime()
	}
	start := int64(0)
	if prev.OK && !prev.Partial && prev.Meta.Title != "" {
		start = prev.Tail.resumeAt(path, size)
	}
	if start > 0 {
		meta = prev.Meta
		meta.File = path
	}
	firstUser := ""
	partial := false
	tail, err := readTail(path, start, func(line []byte) error {
		if len(line) == 0 {
			return nil
		}
		var entry struct {
			Type      string          `json:"type"`
			Timestamp string          `json:"timestamp"`
			Cwd       string          `json:"cwd"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Message   json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			return nil
		}
		if entry.Type == "session" {
			meta.Cwd, meta.ID = filepath.Clean(entry.Cwd), entry.ID
			if start == 0 && want != nil && meta.ID != "" && !want(meta.Cwd) {
				// The header is all this folder's files need.
				partial = true
				return errStopTail
			}
			return nil
		}
		if entry.Type == "session_info" && entry.Name != "" {
			meta.Title = entry.Name
		}
		if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			meta.Updated = t
		}
		if entry.Type != "message" || len(entry.Message) == 0 {
			return nil
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			return nil
		}
		meta.Count++
		if msg.Role == "user" && firstUser == "" {
			if text := strings.TrimSpace(msg.text()); text != "" && !strings.HasPrefix(text, "/") {
				firstUser = text
			} else if text != "" {
				firstUser = text
			}
		}
		return nil
	})
	read := metaRead{start: start, tail: tail}
	if err != nil && err != errStopTail {
		return read
	}
	if partial {
		read.meta, read.ok, read.partial = meta, true, true
		return read
	}
	if meta.ID == "" {
		return read
	}
	if meta.Title == "" && firstUser != "" {
		meta.Title = firstLine(firstUser, 48)
	}
	read.meta, read.ok = meta, true
	return read
}

// importSession copies a session file into the app's own store, so it can
// be resumed here without sharing a file with another app.
func (s *store) importSession(src string) (sessionMeta, error) {
	f, err := os.Open(src)
	if err != nil {
		return sessionMeta{}, err
	}
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	err = json.NewDecoder(bufio.NewReader(f)).Decode(&head)
	f.Close()
	if err != nil || head.Type != "session" || head.ID == "" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	existing, _ := filepath.Glob(filepath.Join(s.sessions, "*", "*_"+head.ID+".jsonl"))
	if len(existing) > 0 {
		return sessionMeta{}, fmt.Errorf("这个会话已经导入过了")
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(head.Cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, time.Now().UTC().Format("2006-01-02T15-04-05-000Z")+"_"+head.ID+".jsonl")
	data, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("导入后无法读取该会话")
	}
	return m, nil
}

// duplicateSession copies a session file under a new id, so the copy can
// be resumed without sharing a file with the original.
func (s *store) duplicateSession(src, id, title string) (sessionMeta, error) {
	if src == "" || id == "" {
		return sessionMeta{}, fmt.Errorf("没有可复制的会话文件")
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	nl := bytes.IndexByte(raw, '\n')
	if nl < 0 {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	var head map[string]any
	if json.Unmarshal(raw[:nl], &head) != nil || head["type"] != "session" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	cwd, _ := head["cwd"].(string)
	now := time.Now().UTC()
	head["id"] = id
	head["timestamp"] = now.Format(time.RFC3339Nano)
	headRaw, err := json.Marshal(head)
	if err != nil {
		return sessionMeta{}, err
	}
	var out bytes.Buffer
	out.Write(headRaw)
	out.WriteByte('\n')
	out.Write(raw[nl+1:])
	if title != "" {
		info, _ := json.Marshal(map[string]any{
			"type":      "session_info",
			"name":      title,
			"timestamp": now.Format(time.RFC3339Nano),
		})
		out.Write(info)
		out.WriteByte('\n')
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("复制后无法读取该会话")
	}
	return m, nil
}

// deleteSession moves a session file out of the way rather than erasing
// it. A process that just closed can hold the file a moment longer, so the
// move is retried before it is reported as failed.
func (s *store) deleteSession(file, id string) error {
	if file == "" {
		return nil
	}
	trash := filepath.Join(s.dir, "trash")
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	dst := filepath.Join(trash, stamp+"-"+id+".jsonl")
	var err error
	for i := 0; i < 12; i++ {
		if err = os.Rename(file, dst); err == nil {
			return nil
		}
		if _, statErr := os.Stat(file); statErr != nil {
			return nil // already gone
		}
		dst = filepath.Join(trash, fmt.Sprintf("%s-%s-%d.jsonl", stamp, id, i+1))
		time.Sleep(time.Duration(60*(i+1)) * time.Millisecond)
	}
	return fmt.Errorf("文件被占用，稍后再试：%w", err)
}

// encodeCwd is pi's session folder name for a working directory: the
// path with its separator, drive colon and slashes flattened.
func encodeCwd(cwd string) string {
	if cwd == "" {
		return "--unknown--"
	}
	r := strings.NewReplacer(":", "-", "\\", "-", "/", "-")
	return "--" + strings.Trim(r.Replace(filepath.Clean(cwd)), "-") + "--"
}

// newSessionID makes a UUID v4, the ID pi uses for a session.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

// shortPath shortens an absolute path for a label, keeping its end.
func shortPath(path string, n int) string {
	runes := []rune(path)
	if len(runes) <= n {
		return path
	}
	return "…" + string(runes[len(runes)-n+1:])
}

// forkSession copies a session up to the user message at turn, writes it
// under a new id, and returns the prompt that was left out so the app can
// put it back in the composer. The original file is not touched.
func (s *store) forkSession(src, id string, turn int, title string) (sessionMeta, string, error) {
	if src == "" || id == "" {
		return sessionMeta{}, "", fmt.Errorf("没有可分叉的会话文件")
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, "", err
	}
	lines := bytes.Split(raw, []byte("\n"))
	if len(lines) == 0 {
		return sessionMeta{}, "", fmt.Errorf("不是有效的 pi 会话文件")
	}
	var head map[string]any
	if json.Unmarshal(lines[0], &head) != nil || head["type"] != "session" {
		return sessionMeta{}, "", fmt.Errorf("不是有效的 pi 会话文件")
	}
	cwd, _ := head["cwd"].(string)
	now := time.Now().UTC()
	head["id"] = id
	head["timestamp"] = now.Format(time.RFC3339Nano)
	headRaw, err := json.Marshal(head)
	if err != nil {
		return sessionMeta{}, "", err
	}
	var out bytes.Buffer
	out.Write(headRaw)
	out.WriteByte('\n')
	seenUser, prompt, found := 0, "", false
	for _, line := range lines[1:] {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) == nil && entry.Type == "message" && len(entry.Message) > 0 {
			var msg piMessage
			if json.Unmarshal(entry.Message, &msg) == nil && msg.Role == "user" {
				if seenUser == turn {
					prompt = msg.text()
					found = true
					break
				}
				seenUser++
			}
		}
		out.Write(line)
		out.WriteByte('\n')
	}
	if !found {
		return sessionMeta{}, "", fmt.Errorf("找不到要分叉的那一轮")
	}
	if title != "" {
		info, _ := json.Marshal(map[string]any{
			"type": "session_info", "name": title, "timestamp": now.Format(time.RFC3339Nano),
		})
		out.Write(info)
		out.WriteByte('\n')
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, "", err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
		return sessionMeta{}, "", err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, "", fmt.Errorf("分叉后无法读取该会话")
	}
	return m, prompt, nil
}
