//go:build !js && !android && !ios

package workbench

// Checks the session tab's width: its bounds, the fallback a config file
// outside them gets, the points a share of a window works out to, and its
// storage.

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestTabWidthPctNormalized checks a stored percentage outside the range
// is dropped back to the default rather than clamped to a surprise.
func TestTabWidthPctNormalized(t *testing.T) {
	for _, pct := range []int{1, tabWidthPctMin - 1, tabWidthPctMax + 1, 90} {
		c := &config{TabWidthPct: pct}
		if !normalizeConfig(c) {
			t.Fatalf("%d should be corrected", pct)
		}
		if c.TabWidthPct != 0 {
			t.Fatalf("%d normalized to %d, want unset", pct, c.TabWidthPct)
		}
	}
	c := &config{TabWidthPct: 16}
	if normalizeConfig(c) {
		t.Fatal("a percentage in range should be left alone")
	}
	if c.TabWidthPct != 16 {
		t.Fatalf("percentage in range changed to %d", c.TabWidthPct)
	}
}

// TestTabWidthPctPersists checks the choice reaches config.json.
func TestTabWidthPctPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) { c.TabWidthPct = 16 })
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.config().TabWidthPct; got != 16 {
		t.Fatalf("stored percent %d, want 16", got)
	}
}

func TestTabWidthPctRestoredAtStartup(t *testing.T) {
	for _, tc := range []struct {
		name   string
		stored int
		want   int
	}{
		{"default", 0, tabWidthPctDefault},
		{"minimum", tabWidthPctMin, tabWidthPctMin},
		{"maximum", tabWidthPctMax, tabWidthPctMax},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_V2_HOME", dir)
			st, err := newStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			st.edit(func(c *config) { c.TabWidthPct = tc.stored })

			var stored, displayed int
			nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a := newApp(cx)
				stored = a.cfg.TabWidthPct
				displayed = a.tabWidthPct()
				return a.view()
			}, nsgotest.Size(1200, 800))
			if stored != tc.stored {
				t.Fatalf("loaded tab width = %d, want %d", stored, tc.stored)
			}
			if displayed != tc.want {
				t.Fatalf("startup tab width = %d, want %d (config kept %d)", displayed, tc.want, stored)
			}
		})
	}
}

// TestTabWidthPoints checks a share of the window works out to points, the
// floor holds on a narrow window, and a window that has not been measured
// falls back rather than collapsing the tab.
func TestTabWidthPoints(t *testing.T) {
	cases := []struct {
		name   string
		window core.Points
		pct    int
		want   core.Points
	}{
		{"default on a wide window", 1400, tabWidthPctDefault, 308},
		{"narrow setting", 1400, tabWidthPctMin, 112},
		{"wide setting", 1400, tabWidthPctMax, 420},
		{"floor on a narrow window", 400, tabWidthPctMin, 96},
		{"unknown window falls back", 0, tabWidthPctDefault, 264},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tabWidthPoints(tc.window, tc.pct); got != tc.want {
				t.Fatalf("tabWidthPoints(%v, %d) = %v, want %v", tc.window, tc.pct, got, tc.want)
			}
		})
	}
}

// TestTabWidthRangeKeepsATitleReadable checks the range's floor is wide
// enough for a short title: a minimum well under a hundred points would
// clip every tab to an ellipsis.
func TestTabWidthRangeKeepsATitleReadable(t *testing.T) {
	if tabWidthPctMin <= 0 || tabWidthPctMin >= tabWidthPctDefault {
		t.Fatalf("minimum %d should sit under the default %d", tabWidthPctMin, tabWidthPctDefault)
	}
	if tabWidthPctDefault >= tabWidthPctMax {
		t.Fatalf("default %d should sit under the maximum %d", tabWidthPctDefault, tabWidthPctMax)
	}
	if got := tabWidthPoints(1400, tabWidthPctMin); got < 96 {
		t.Fatalf("the narrowest tab is %v points, too narrow for a title", got)
	}
}
