//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"bytes"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
)

// configVersion is the shape of config.json this build writes. A file
// from an older build is migrated on load and written back once.
const configVersion = 4

// chatWidthPtMin and chatWidthPtMax were the old chat width slider's
// range in points; they convert a config written before percentages. The
// percentage that range mapped onto was 50 to 90, which stays the
// conversion's upper end however far the slider reaches now.
const (
	chatWidthPtMin = 520
	chatWidthPtMax = 1000
	// chatWidthPctLegacyMax is the percentage chatWidthPtMax mapped onto.
	chatWidthPctLegacyMax = 90
)

// chatWidthPctFromPoints maps the old reading width in points onto the
// percentage range it was stored against, rounding to the nearest whole
// percent.
func chatWidthPctFromPoints(pt int) int {
	span := chatWidthPtMax - chatWidthPtMin
	pct := chatWidthPctMin + ((pt-chatWidthPtMin)*(chatWidthPctLegacyMax-chatWidthPctMin)+span/2)/span
	if pct < chatWidthPctMin {
		pct = chatWidthPctMin
	}
	if pct > chatWidthPctLegacyMax {
		pct = chatWidthPctLegacyMax
	}
	return pct
}

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
	if c.Version < 3 {
		// The reading width was points before it became a percentage:
		// convert it once, then drop the old field. An unset width stays
		// unset, so the runtime default applies.
		if c.ChatWidthPct == 0 && c.ChatWidth != 0 {
			c.ChatWidthPct = chatWidthPctFromPoints(c.ChatWidth)
		}
		c.ChatWidth = 0
		c.Version = 3
		changed = true
	}
	if c.Version < 4 {
		c.Version = 4
		changed = true
	}
	return normalizeConfig(c) || changed
}

// normalizeConfig resets values a hand-edited file could have got wrong:
// unknown choices, out-of-range sizes, and duplicate projects or tabs.
func normalizeConfig(c *config) bool {
	changed := normalizeBrandConfig(c)
	if c.VoiceLocalURL != "" {
		if _, err := whisperURL(c.VoiceLocalURL); err != nil {
			c.VoiceLocalURL = ""
			changed = true
		}
	}
	if c.ACPSilenceSec != 0 && c.ACPSilenceSec != acpSilenceSeconds(c.ACPSilenceSec) {
		c.ACPSilenceSec = 0
		changed = true
	}
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
	trim(&c.BackgroundVideo)
	if spec := normalizeComposerMetrics(c.FooterMetrics); spec != c.FooterMetrics {
		c.FooterMetrics = spec
		changed = true
	}
	if c.BackgroundVideo != "" && !wallpaperVideo(c.BackgroundVideo) {
		c.BackgroundVideo = ""
		changed = true
	}
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
	if c.Language != apptext.LangSystem && !apptext.SupportedLanguage(c.Language) {
		c.Language = ""
		changed = true
	}
	if c.TerminalHeight != 0 && (c.TerminalHeight < 120 || c.TerminalHeight > 1200) {
		c.TerminalHeight = 0
		changed = true
	}
	if c.ChatWidthPct != 0 && (c.ChatWidthPct < chatWidthPctMin || c.ChatWidthPct > chatWidthPctMax) {
		c.ChatWidthPct = 0
		changed = true
	}
	if c.TabWidthPct != 0 && (c.TabWidthPct < tabWidthPctMin || c.TabWidthPct > tabWidthPctMax) {
		c.TabWidthPct = 0
		changed = true
	}
	// The point width is only migration input; a file that still carries
	// one has already been converted, so drop it.
	if c.ChatWidth != 0 {
		c.ChatWidth = 0
		changed = true
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
	if c.ChatFont != 0 && (c.ChatFont < viewkit.ChatFontMin || c.ChatFont > viewkit.ChatFontMax) {
		c.ChatFont = 0
		changed = true
	}
	if c.ChatLine != 0 && (c.ChatLine < viewkit.ChatLineMin || c.ChatLine > viewkit.ChatLineMax) {
		c.ChatLine = 0
		changed = true
	}
	if c.InputFont != 0 && (c.InputFont < viewkit.ChatFontMin || c.InputFont > viewkit.ChatFontMax) {
		c.InputFont = 0
		changed = true
	}

	if c.RemotePort != 0 && (c.RemotePort < 1 || c.RemotePort > 65535) {
		c.RemotePort = 0
		changed = true
	}
	// A hand-edited issue time counts from the epoch: the next tick rotates
	// rather than waiting for a date in the past.
	if c.RemoteTokenIssued < 0 {
		c.RemoteTokenIssued = 0
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
