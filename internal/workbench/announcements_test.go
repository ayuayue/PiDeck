//go:build !js && !android && !ios

package workbench

// Checks the announcement feed: what a broken entry, an expired one and a
// version gate do, and that the read marks survive a restart.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// announceTestNow is the clock the feed is read at.
var announceTestNow = time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

func announceAt(visible time.Duration) string {
	return announceTestNow.Add(visible).Format(time.RFC3339)
}

// TestFilterAnnouncements keeps what applies and drops the rest.
func TestFilterAnnouncements(t *testing.T) {
	items := []announceItem{
		{ID: "old", Title: "过期了", Body: "", Level: announceInfo,
			PublishedAt: announceAt(-48 * time.Hour), EffectiveUntil: announceAt(-time.Hour)},
		{ID: "new", Title: "新消息", Body: "正文", Level: announceWarn,
			PublishedAt: announceAt(-time.Hour), EffectiveUntil: announceAt(24 * time.Hour)},
		{ID: "", Title: "没有 id", Level: announceInfo,
			PublishedAt: announceAt(-time.Hour), EffectiveUntil: announceAt(24 * time.Hour)},
		{ID: "loud", Title: "级别不认识", Level: "shout",
			PublishedAt: announceAt(-time.Hour), EffectiveUntil: announceAt(24 * time.Hour)},
		{ID: "undated", Title: "没有时间", Level: announceInfo, EffectiveUntil: announceAt(24 * time.Hour)},
		{ID: "gate", Title: "0.3 才消失", Level: announceInfo, MinVersion: "0.3.0",
			PublishedAt: announceAt(-2 * time.Hour), EffectiveUntil: announceAt(24 * time.Hour)},
		{ID: "guide", Title: "常驻说明", Level: announceInfo,
			PublishedAt: announceAt(-3 * time.Hour), EffectiveUntil: announceAt(48 * time.Hour)},
	}
	got := filterAnnouncements(items, announceTestNow, "0.2.0")
	var ids []string
	for _, it := range got {
		ids = append(ids, it.ID)
	}
	want := []string{"new", "gate", "guide"}
	if len(ids) != len(want) {
		t.Fatalf("kept %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("kept %v, want %v (newest first)", ids, want)
		}
	}
	if got[0].Category != announceNotice {
		t.Errorf("a missing category stayed %q, want %q", got[0].Category, announceNotice)
	}
	// The same feed read by a newer build loses the entry gated on it.
	for _, it := range filterAnnouncements(items, announceTestNow, "0.3.0") {
		if it.ID == "gate" {
			t.Fatalf("the 0.3.0 gate survived a 0.3.0 build")
		}
	}
}

// TestParseAnnouncements accepts version 1 only, and says so.
func TestParseAnnouncements(t *testing.T) {
	if _, ok := parseAnnouncements([]byte("{"), announceTestNow, "0.2.0"); ok {
		t.Fatal("broken JSON counted as a feed")
	}
	if _, ok := parseAnnouncements([]byte(`{"version":2,"items":[]}`), announceTestNow, "0.2.0"); ok {
		t.Fatal("version 2 counted as a feed")
	}
	items, ok := parseAnnouncements([]byte(`{"version":1,"items":[]}`), announceTestNow, "0.2.0")
	if !ok || len(items) != 0 {
		t.Fatalf("an empty feed = %v, %v", items, ok)
	}
}

// TestUnwrapAnnounceContents reads AtomGit's base64 wrapper.
func TestUnwrapAnnounceContents(t *testing.T) {
	feed := `{"version":1,"items":[]}`
	wrapped, err := json.Marshal(map[string]string{
		"encoding": "base64",
		"content":  base64.StdEncoding.EncodeToString([]byte(feed)) + "\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := unwrapAnnounceContents(wrapped)
	if err != nil || string(raw) != feed {
		t.Fatalf("unwrap = %q, %v", raw, err)
	}
	if _, err := unwrapAnnounceContents([]byte(feed)); err == nil {
		t.Fatal("a plain file counted as a contents answer")
	}
}

// TestVersionLess compares the numbers before anything else.
func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.3.0", true},
		{"0.3.0", "0.2.0", false},
		{"0.2.0", "0.2.0", false},
		{"v0.2.1", "0.3", true},
		{"0.2.0-beta.1", "0.2.0", false},
		{"1.0", "0.9.9", false},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// TestAnnounceReadMarksSurviveRestart checks the cache file keeps the feed
// and which entries were read.
func TestAnnounceReadMarksSurviveRestart(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Second)
	first := &app{st: st}
	first.announceItems = []announceItem{{ID: "a", Title: "一", Level: announceInfo, Category: announceNotice,
		PublishedAt: now.Add(-time.Hour).Format(time.RFC3339), EffectiveUntil: now.Add(24 * time.Hour).Format(time.RFC3339)}}
	first.announceRead = map[string]bool{"a": true}
	first.announceFetched = now
	first.saveAnnouncementsLocked()

	second := &app{st: st}
	second.loadAnnouncements()
	if len(second.announceItems) != 1 || second.announceItems[0].ID != "a" {
		t.Fatalf("reloaded %+v", second.announceItems)
	}
	if !second.announceRead["a"] {
		t.Fatal("the read mark was lost")
	}
	if second.announceUnread() != 0 {
		t.Fatalf("read news still counts %d unread", second.announceUnread())
	}
	if !second.announceFetched.Equal(now) {
		t.Fatalf("fetched at %v, want %v", second.announceFetched, now)
	}
}

// TestAnnouncementAndFeedbackDialogs checks the rail's footer opens both
// new dialogs, and that an announcement left by an earlier run is read
// when the center opens.
func TestAnnouncementAndFeedbackDialogs(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	now := time.Now().Truncate(time.Second)
	cache := announceCache{Version: 1, FetchedAt: now.Format(time.RFC3339), Items: []announceItem{{
		ID: "kept", Title: "上次的公告", Body: "正文", Level: announceInfo, Category: announceNotice,
		PublishedAt: now.Add(-time.Hour).Format(time.RFC3339), EffectiveUntil: now.Add(24 * time.Hour).Format(time.RFC3339)}}}
	raw, err := json.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "announcements-cache.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-announcements")
	app.WaitFor("id:announce-dialog", 5*time.Second)
	app.WaitFor("text:上次的公告", 5*time.Second)
	app.Press("label:关闭")
	app.Press("id:rail-feedback")
	app.WaitFor("id:feedback-dialog", 5*time.Second)
	app.WaitFor("id:feedback-copy", 5*time.Second)
}
