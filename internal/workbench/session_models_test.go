//go:build !js && !android && !ios

package workbench

// Checks for the two cycle keys' decisions: which stars take part, and
// which one comes next. The wiring around them is the same applyModel /
// applyThinking path the pickers use.

import "testing"

// TestFavouriteCycle checks a star only takes part while its catalog still
// offers it, in star order, once each.
func TestFavouriteCycle(t *testing.T) {
	offered := []modelInfo{
		{Provider: "magpie", ID: "a"},
		{Provider: "magpie", ID: "b"},
		{Provider: "other", ID: "c"},
	}
	favs := []string{"magpie/b", "gone/x", "other/c", "magpie/b", "magpie/a"}
	got := favouriteCycle(favs, offered)
	want := []string{"magpie/b", "other/c", "magpie/a"}
	if len(got) != len(want) {
		t.Fatalf("favouriteCycle = %+v, want %v", got, want)
	}
	for i, key := range want {
		if got[i].Provider+"/"+got[i].ID != key {
			t.Fatalf("favouriteCycle[%d] = %s/%s, want %s", i, got[i].Provider, got[i].ID, key)
		}
	}
	// A catalog that has not loaded yet leaves nothing to cycle.
	if out := favouriteCycle(favs, nil); len(out) != 0 {
		t.Fatalf("an empty catalog cycled %+v", out)
	}
}

// TestNextInCycle checks the wrap, the first item for an unstarred
// current model, and the empty case the caller refuses.
func TestNextInCycle(t *testing.T) {
	cases := []struct{ n, cur, want int }{
		{0, 0, 0},  // nothing to cycle
		{1, 0, 0},  // one item stays put
		{3, 0, 1},  // forward
		{3, 1, 2},  // forward
		{3, 2, 0},  // wraps at the end
		{3, -1, 0}, // the current model is not in the list
		{2, -5, 0},
	}
	for _, c := range cases {
		if got := nextInCycle(c.n, c.cur); got != c.want {
			t.Errorf("nextInCycle(%d, %d) = %d, want %d", c.n, c.cur, got, c.want)
		}
	}
}
