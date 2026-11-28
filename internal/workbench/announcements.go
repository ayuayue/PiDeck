//go:build !js && !android && !ios

package workbench

// Announcements: the maintainer's news, in a feed file the repository
// carries, read a moment after the app starts and every couple of hours
// after that. AtomGit's contents API comes first and GitHub's raw file
// is the fallback, the order PiDeck settled on so the feed stays
// reachable from inside China. A broken entry is dropped rather than
// repaired: the file comes from a commit someone can fix.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"example.com/pideck/internal/appinfo"
)

// Where the feed lives, and how often it is read.
const (
	announceOwner        = "ayuayue"
	announceRepo         = "PiDeck"
	announceFile         = "announcements.json"
	announceBranch       = "nsgo"
	announceMirrorRepo   = "PiDeck-V2"
	announceMirrorBranch = "main"
	// announceEvery is the wait between reads, and announceStartup the
	// first one's, so desktops opening together do not hit the source at
	// once.
	announceEvery   = 2 * time.Hour
	announceStartup = 20 * time.Second
	// announceMaxBytes bounds one response: the feed is a small file.
	announceMaxBytes = 256 << 10
	// announceLimit bounds the entries kept, newest first.
	announceLimit = 60
	// announceReadLimit bounds the ids remembered as read.
	announceReadLimit = 200
)

// The levels and kinds a feed can name.
const (
	announceInfo     = "info"
	announceWarn     = "warn"
	announceCritical = "critical"

	// flash is news for a moment, notice a broadcast that stays, and
	// guide a standing note that never raises the unread dot.
	announceFlash  = "flash"
	announceNotice = "notice"
	announceGuide  = "guide"
)

// announceItem is one announcement, as the feed states it.
type announceItem struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Body           string `json:"body"`
	Level          string `json:"level"`
	Category       string `json:"category,omitempty"`
	PublishedAt    string `json:"publishedAt"`
	EffectiveUntil string `json:"effectiveUntil"`
	MinVersion     string `json:"minVersion,omitempty"`
}

// announceFeed is the file the repository carries.
type announceFeed struct {
	Version int            `json:"version"`
	Items   []announceItem `json:"items"`
}

// announceCache is announcements-cache.json: the last feed read, when it
// was read, and the entries the user has opened. It keeps the dot off
// until there is something new, and shows the last news while offline.
type announceCache struct {
	Version   int            `json:"version"`
	FetchedAt string         `json:"fetchedAt,omitempty"`
	Items     []announceItem `json:"items"`
	Read      []string       `json:"read,omitempty"`
}

// announceSource is one place the feed is read from. AtomGit wraps the
// file in a base64 contents answer; GitHub's raw host serves it as is.
type announceSource struct {
	URL     string
	Wrapped bool
}

// announceSources are tried in order; the first usable answer wins.
func announceSources() []announceSource {
	return []announceSource{
		{URL: fmt.Sprintf("https://api.atomgit.com/api/v5/repos/%s/%s/contents/%s?ref=%s",
			announceOwner, announceMirrorRepo, announceFile, announceMirrorBranch), Wrapped: true},
		{URL: fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s",
			announceOwner, announceRepo, announceBranch, announceFile)},
	}
}

// parseAnnouncements reads a feed and keeps what this build may show now.
// The second result says whether the feed itself was usable, so a broken
// source is skipped rather than shown as "no news".
func parseAnnouncements(raw []byte, now time.Time, version string) ([]announceItem, bool) {
	var feed announceFeed
	if err := json.Unmarshal(raw, &feed); err != nil || feed.Version != 1 {
		return nil, false
	}
	return filterAnnouncements(feed.Items, now, version), true
}

// filterAnnouncements drops entries that cannot be shown: malformed,
// expired, or meant for another version. What is left reads newest first.
func filterAnnouncements(items []announceItem, now time.Time, version string) []announceItem {
	out := make([]announceItem, 0, len(items))
	for _, it := range items {
		it.ID = strings.TrimSpace(it.ID)
		it.Title = strings.TrimSpace(it.Title)
		it.Body = strings.TrimSpace(it.Body)
		if it.ID == "" || len([]rune(it.ID)) > 128 {
			continue
		}
		if it.Title == "" || len([]rune(it.Title)) > 200 || len([]rune(it.Body)) > 5000 {
			continue
		}
		switch it.Level {
		case announceInfo, announceWarn, announceCritical:
		default:
			continue
		}
		switch it.Category {
		case announceFlash, announceNotice, announceGuide:
		default:
			it.Category = announceNotice
		}
		if _, err := time.Parse(time.RFC3339, it.PublishedAt); err != nil {
			continue
		}
		until, err := time.Parse(time.RFC3339, it.EffectiveUntil)
		if err != nil || !now.Before(until) {
			continue
		}
		// minVersion marks news for older builds: once the app reaches it,
		// the entry has said what it had to say.
		if it.MinVersion != "" && !versionLess(version, it.MinVersion) {
			continue
		}
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return announcePublished(out[i]).After(announcePublished(out[j]))
	})
	if len(out) > announceLimit {
		out = out[:announceLimit]
	}
	return out
}

// announcePublished is an item's date; filterAnnouncements checked it.
func announcePublished(it announceItem) time.Time {
	t, _ := time.Parse(time.RFC3339, it.PublishedAt)
	return t
}

// versionLess reports whether a is older than b, comparing the
// dot-separated numbers and ignoring anything after a dash.
func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

// versionParts reads up to three numbers from a version.
func versionParts(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		if i > 2 {
			break
		}
		n := 0
		for _, r := range part {
			if r < '0' || r > '9' {
				break
			}
			n = n*10 + int(r-'0')
		}
		out[i] = n
	}
	return out
}

// readAnnouncements reads the feed from the first source that answers
// with one this build can show.
func readAnnouncements(now time.Time, version string) ([]announceItem, error) {
	var firstErr error
	for _, src := range announceSources() {
		items, err := readAnnounceSource(src, now, version)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		return items, nil
	}
	if firstErr == nil {
		firstErr = errors.New("没有可用的公告源")
	}
	return nil, firstErr
}

// readAnnounceSource reads one source and says what went wrong with it.
func readAnnounceSource(src announceSource, now time.Time, version string) ([]announceItem, error) {
	resp, err := appHTTPClient.Get(src.URL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, announceMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > announceMaxBytes {
		return nil, fmt.Errorf("公告超过 %d KB", announceMaxBytes>>10)
	}
	if src.Wrapped {
		raw, err = unwrapAnnounceContents(raw)
		if err != nil {
			return nil, err
		}
	}
	items, ok := parseAnnouncements(raw, now, version)
	if !ok {
		return nil, errors.New("公告格式不认识")
	}
	return items, nil
}

// unwrapAnnounceContents reads AtomGit's base64-wrapped contents answer.
func unwrapAnnounceContents(raw []byte) ([]byte, error) {
	var wrapped struct {
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	if err := json.Unmarshal(raw, &wrapped); err != nil || wrapped.Encoding != "base64" || wrapped.Content == "" {
		return nil, errors.New("不是 AtomGit 的 contents 响应")
	}
	out, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(wrapped.Content, "\n", ""))
	if err != nil {
		return nil, err
	}
	return out, nil
}

// announceCachePath is where the last feed read is kept.
func (a *app) announceCachePath() string {
	if a == nil || a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "announcements-cache.json")
}

// loadAnnouncements reads the last feed and the read marks, so a restart
// shows the news before the source answers.
func (a *app) loadAnnouncements() {
	a.announceRead = map[string]bool{}
	path := a.announceCachePath()
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var cache announceCache
	if json.Unmarshal(raw, &cache) != nil || cache.Version != 1 {
		return
	}
	a.announceItems = filterAnnouncements(cache.Items, time.Now(), appinfo.Version)
	for _, id := range cache.Read {
		if id = strings.TrimSpace(id); id != "" {
			a.announceRead[id] = true
		}
	}
	if at, err := time.Parse(time.RFC3339, cache.FetchedAt); err == nil {
		a.announceFetched = at
	}
}

// saveAnnouncementsLocked writes the feed and the read marks. The caller
// holds announceMu.
func (a *app) saveAnnouncementsLocked() {
	path := a.announceCachePath()
	if path == "" {
		return
	}
	read := make([]string, 0, len(a.announceRead))
	for id := range a.announceRead {
		read = append(read, id)
	}
	sort.Strings(read)
	if len(read) > announceReadLimit {
		read = read[len(read)-announceReadLimit:]
	}
	cache := announceCache{Version: 1, Items: a.announceItems, Read: read}
	if !a.announceFetched.IsZero() {
		cache.FetchedAt = a.announceFetched.Format(time.RFC3339)
	}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// startAnnouncements reads the feed once the window has settled.
func (a *app) startAnnouncements() {
	a.cx.AfterFunc(announceStartup, a.announceTick)
}

// announceTick reads the feed and sets up the next read.
func (a *app) announceTick() {
	a.fetchAnnouncements(false)
	a.cx.AfterFunc(announceEvery, a.announceTick)
}

// fetchAnnouncements reads the feed in the background. A failure keeps
// what is on screen and only records why.
func (a *app) fetchAnnouncements(manual bool) {
	if a.announceBusy.GetUntracked() {
		return
	}
	a.announceBusy.Set(true)
	if manual {
		a.announceErr.Set("")
	}
	now := time.Now()
	go func() {
		items, err := readAnnouncements(now, appinfo.Version)
		a.cx.Post(func() {
			a.announceBusy.Set(false)
			if err != nil {
				a.announceErr.Set(err.Error())
				a.diagf("warn", "公告读取失败：%v", err)
				return
			}
			a.announceMu.Lock()
			a.announceItems, a.announceFetched = items, now
			a.saveAnnouncementsLocked()
			a.announceMu.Unlock()
			a.announceErr.Set("")
			a.announceRev.Update(func(n int) int { return n + 1 })
		})
	}()
}

// announceUnread is how many entries the rail's dot stands for: read ones
// and standing guides do not count.
func (a *app) announceUnread() int {
	a.announceMu.Lock()
	defer a.announceMu.Unlock()
	n := 0
	for _, it := range a.announceItems {
		if it.Category == announceGuide || a.announceRead[it.ID] {
			continue
		}
		n++
	}
	return n
}

// announceList and announceReadSet copy what the dialog draws.
func (a *app) announceList() []announceItem {
	a.announceMu.Lock()
	defer a.announceMu.Unlock()
	return append([]announceItem(nil), a.announceItems...)
}

func (a *app) announceReadSet() map[string]bool {
	a.announceMu.Lock()
	defer a.announceMu.Unlock()
	out := make(map[string]bool, len(a.announceRead))
	for id, seen := range a.announceRead {
		out[id] = seen
	}
	return out
}

// markAnnouncementsRead clears the dot: opening the center reads what it
// lists. Standing guides keep their place in the list, unmarked.
func (a *app) markAnnouncementsRead() {
	a.announceMu.Lock()
	changed := false
	for _, it := range a.announceItems {
		if it.Category == announceGuide || a.announceRead[it.ID] {
			continue
		}
		a.announceRead[it.ID] = true
		changed = true
	}
	if changed {
		a.saveAnnouncementsLocked()
	}
	a.announceMu.Unlock()
	if changed {
		a.announceRev.Update(func(n int) int { return n + 1 })
	}
}
