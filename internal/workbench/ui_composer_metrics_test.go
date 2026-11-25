//go:build !js && !android && !ios

package workbench

// Checks the composer footer's line of numbers: the spec it reads, and the
// groups it draws for a session that has answered once.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestComposerMetricSpec keeps the stored spec canonical: the default set
// when empty, drawing order, and "none" when nothing is left.
func TestComposerMetricSpec(t *testing.T) {
	cases := []struct{ spec, want string }{
		{"", composerMetricsDefault},
		{"none", composerMetricsNone},
		{"tokens,turns", "turns,tokens"},
		{" turns , cache ", "turns,cache"},
		{"turns,bogus", "turns"},
		{",", composerMetricsNone},
	}
	for _, c := range cases {
		if got := composerMetricsSpec(parseComposerMetrics(c.spec)); got != c.want {
			t.Errorf("spec %q parses and writes back as %q, want %q", c.spec, got, c.want)
		}
	}
	if got := normalizeComposerMetrics(""); got != "" {
		t.Errorf("empty spec normalized to %q; empty means the default set", got)
	}
	if got := normalizeComposerMetrics("cost,turns,cost"); got != "turns,cost" {
		t.Errorf("duplicate spec normalized to %q, want turns,cost", got)
	}
}

// TestToggleComposerMetric flips one group without disturbing the others,
// including the way back from an empty row.
func TestToggleComposerMetric(t *testing.T) {
	cases := []struct{ spec, id, want string }{
		{"", "reply", "turns,cache,tokens"},
		{"turns,cache,tokens", "reply", composerMetricsDefault},
		{composerMetricsNone, "turns", "turns"},
		{"turns", "turns", composerMetricsNone},
	}
	for _, c := range cases {
		if got := toggleComposerMetric(c.spec, c.id); got != c.want {
			t.Errorf("toggle %q in %q = %q, want %q", c.id, c.spec, got, c.want)
		}
	}
}

// TestComposerFooterMetrics draws the line from what the session reported
// and hides a group the moment its chip is switched off.
func TestComposerFooterMetrics(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.stats.Set(sessionStats{Known: true, UserMessages: 3, AssistantMessages: 7, ToolCalls: 12,
			ContextTokens: 122000, ContextWindow: 272000, ContextPercent: 44.8,
			Tokens: usageInfo{Input: 128000, Output: 9000, CacheRead: 420000, CacheWrite: 33000, Total: 590000}})
		sess.usage.Set(usageInfo{Input: 128000, Output: 9000, CacheRead: 420000, CacheWrite: 33000, Total: 590000, Cost: 0.42})
		sess.perf.Set(replyPerf{TTFT: 480 * time.Millisecond, Total: 7 * time.Second, Output: 620, LastPrompt: 122000,
			HitLast: 82.4, HitSum: 312.8, HitCount: 4, HasHit: true, HasTTFT: true, HasReplySpeed: true})
	})
	screen.WaitFor("id:composer-metrics", 5*time.Second)
	for _, text := range []string{"text:3 轮", "text:回复 7.0s · 流式 — · 均速 89 tok/s", "text:缓存命中 82%",
		"text:输入 128k tok · 输出 9k tok"} {
		screen.WaitFor(text, 5*time.Second)
	}
	// Context and cost are off by default: the ring's panel owns them.
	if got := screen.Query("text:上下文 45%"); len(got) != 0 {
		t.Fatalf("context group shows by default: %d nodes", len(got))
	}
	shot(screen, "comparison/composer-metrics")

	// One quiet line under the card, its groups in drawing order.
	card := screen.Find("id:composer-card").Bounds()
	metrics := screen.Find("id:composer-metrics").Bounds()
	if metrics.Origin.Y < card.Origin.Y+card.Size.Height-1 {
		t.Fatalf("metrics y = %v, card ends at %v; the line belongs under the card", metrics.Origin.Y, card.Origin.Y+card.Size.Height)
	}
	if gap := card.Origin.X + card.Size.Width - (metrics.Origin.X + metrics.Size.Width); gap < 0 || gap > 20 {
		t.Fatalf("metrics end %v points inside the card's right edge, want within 20", gap)
	}
	var lastX, lastY core.Points
	for _, text := range []string{"text:3 轮", "text:回复 7.0s · 流式 — · 均速 89 tok/s", "text:缓存命中 82%",
		"text:输入 128k tok · 输出 9k tok"} {
		b := screen.Find(text).Bounds()
		if lastX > 0 && b.Origin.X <= lastX {
			t.Fatalf("%q starts at %v, not after the group before it at %v", text, b.Origin.X, lastX)
		}
		if lastY > 0 && b.Origin.Y != lastY {
			t.Fatalf("%q sits at y = %v, want %v: the groups share one line", text, b.Origin.Y, lastY)
		}
		lastX, lastY = b.Origin.X, b.Origin.Y
	}

	screen.Press("id:composer-metrics")
	screen.WaitFor("id:composer-metrics-menu", 5*time.Second)
	shot(screen, "comparison/composer-metrics-menu")
	screen.Press("id:composer-metric-cache")
	screen.WaitForGone("text:缓存命中 82%", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if got := built.footerMetrics.GetUntracked(); got != "turns,reply,tokens" {
			t.Errorf("footer spec after hiding cache = %q, want turns,reply,tokens", got)
		}
	})
	screen.Press("id:composer-metric-context")
	screen.WaitFor("text:上下文 45%", 5*time.Second)
	screen.Press("id:composer-metric-cache")
	screen.WaitFor("text:缓存命中 82%", 5*time.Second)
}

// TestComposerFooterMetricChips keeps the same choices in 设置 → 外观: a
// chip per group, lit while the footer shows it.
func TestComposerFooterMetricChips(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	built, screen, _ := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsSection("look")
		built.openSettingsPane()
	})
	screen.WaitFor("id:footer-metric-turns", 10*time.Second)
	for _, id := range []string{"id:footer-metric-reply", "id:footer-metric-cache", "id:footer-metric-context"} {
		screen.WaitFor(id, 5*time.Second)
	}
	screen.Press("id:footer-metric-cache")
	onNativeUI(t, screen, built, func() {
		if got := built.footerMetrics.GetUntracked(); got != "turns,reply,tokens" {
			t.Fatalf("footer spec after the chip = %q, want turns,reply,tokens", got)
		}
	})
	if got := screen.Query("id:footer-metric-cache"); len(got) != 1 {
		t.Fatalf("chips after a press = %d, want the row to stay in place", len(got))
	}
}
