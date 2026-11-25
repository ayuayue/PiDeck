//go:build !js && !android && !ios

package workbench

// Checks the rail's session tree: which session reads under which, and the
// cases that must not lose or hide one.

import (
	"fmt"
	"testing"
	"time"
)

// sessionAt builds a listed session for the tree tests: an id, the file pi
// wrote, and the parent its header names.
func sessionAt(id, file, parent string) *session {
	return &session{ID: id, File: file, Parent: parent, External: true}
}

func parentIDs(parents map[string]string) map[string]string {
	out := make(map[string]string, len(parents))
	for child, parent := range parents {
		out[child] = parent
	}
	return out
}

// A subagent names the session that spawned it by its file path; the rail
// has to find it whatever shape that path arrives in.
func TestSessionParentsResolveTheHeaderPath(t *testing.T) {
	parent := sessionAt("p1", `C:\work\proj\.pideck\2026-01-01_10-00-00_p1.jsonl`, "")
	cases := []struct {
		name   string
		header string
		want   string
	}{
		{"the path pi wrote", `C:\work\proj\.pideck\2026-01-01_10-00-00_p1.jsonl`, "p1"},
		{"another case", `c:\WORK\proj\.pideck\2026-01-01_10-00-00_p1.jsonl`, "p1"},
		{"another separator", `C:/work/proj/.pideck/2026-01-01_10-00-00_p1.jsonl`, "p1"},
		{"a relative path", `2026-01-01_10-00-00_p1.jsonl`, "p1"},
		{"a folder that moved", `/elsewhere/2026-01-01_10-00-00_p1.jsonl`, "p1"},
		{"the id alone", `p1`, "p1"},
		{"a file nobody listed", `/elsewhere/2026-01-01_10-00-00_zzz.jsonl`, ""},
		{"nothing", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			child := sessionAt("c1", "/x/2026-01-01_11-00-00_c1.jsonl", c.header)
			got := sessionParents([]*session{parent, child}, nil, nil)
			if got["c1"] != c.want {
				t.Fatalf("child parent = %q, want %q", got["c1"], c.want)
			}
		})
	}
}

// The user's own link wins over the header, and the fork the app recorded
// fills in when the header says nothing.
func TestSessionParentsPreferTheUserThenTheHeader(t *testing.T) {
	a := sessionAt("a", "/x/1_a.jsonl", "")
	b := sessionAt("b", "/x/2_b.jsonl", "")
	c := sessionAt("c", "/x/3_c.jsonl", "/x/1_a.jsonl")
	d := sessionAt("d", "/x/4_d.jsonl", "")
	list := []*session{a, b, c, d}
	links := map[string]sessionLink{"c": {Parent: "b"}}
	forks := map[string]string{"d": "a"}
	got := parentIDs(sessionParents(list, links, forks))
	if got["c"] != "b" {
		t.Fatalf("a user's link lost to the header: %q", got["c"])
	}
	if got["d"] != "a" {
		t.Fatalf("a recorded fork did not nest: %q", got["d"])
	}
}

// A loop between headers, or a session naming itself, must leave rows on
// screen: the link that closes a loop is dropped, and the pair still reads
// as two rows.
func TestSessionParentsDropLoops(t *testing.T) {
	a := sessionAt("a", "/x/1_a.jsonl", "/x/2_b.jsonl")
	b := sessionAt("b", "/x/2_b.jsonl", "/x/1_a.jsonl")
	self := sessionAt("s", "/x/3_s.jsonl", "/x/3_s.jsonl")
	list := []*session{a, b, self}
	got := parentIDs(sessionParents(list, nil, nil))
	if got["a"] == "b" && got["b"] == "a" {
		t.Fatalf("a loop survived: %v", got)
	}
	if got["s"] != "" {
		t.Fatalf("a session parents itself: %v", got)
	}
	f := buildSessionForest(list, got)
	if n := len(f.roots) + len(f.kids["a"]) + len(f.kids["b"]); n != 3 {
		t.Fatalf("the loop lost a row: %d of 3 sessions read", n)
	}
}

// A chain longer than the cap stops nesting where it can no longer read.
func TestSessionParentsBoundTheDepth(t *testing.T) {
	list := make([]*session, 0, maxSessionDepth+4)
	list = append(list, sessionAt("s0", "/x/0_s0.jsonl", ""))
	for i := 1; i < maxSessionDepth+4; i++ {
		list = append(list, sessionAt(fmt.Sprintf("s%d", i), fmt.Sprintf("/x/%d_s%d.jsonl", i, i),
			fmt.Sprintf("/x/%d_s%d.jsonl", i-1, i-1)))
	}
	parents := sessionParents(list, nil, nil)
	depth := 0
	for id := fmt.Sprintf("s%d", maxSessionDepth+3); id != "" && depth < 100; id = parents[id] {
		depth++
	}
	if depth >= maxSessionDepth+4 {
		t.Fatalf("the chain ran %d deep, past the cap", depth)
	}
}

// A parent outside the listing leaves its children as roots: a subagent
// whose parent sits in another folder still shows.
func TestSessionForestKeepsOrphansAsRoots(t *testing.T) {
	parent := sessionAt("p", "/x/1_p.jsonl", "")
	child := sessionAt("c", "/x/2_c.jsonl", "/x/1_p.jsonl")
	// The listing holds the child only, as another project's page would.
	f := buildSessionForest([]*session{child}, sessionParents([]*session{parent, child}, nil, nil))
	if len(f.roots) != 1 || f.roots[0].ID != "c" {
		t.Fatalf("roots = %v, want the child", f.roots)
	}
}

// A parent whose subagent just worked rises with it, and siblings read by
// the newest activity below them.
func TestSessionForestSortsBySubtreeActivity(t *testing.T) {
	now := time.Now()
	older := now.Add(-4 * time.Hour)
	parent := sessionAt("p", "/x/1_p.jsonl", "")
	child := sessionAt("c", "/x/2_c.jsonl", "/x/1_p.jsonl")
	other := sessionAt("o", "/x/3_o.jsonl", "")
	when := map[string]time.Time{"p": older, "c": now, "o": now.Add(-2 * time.Hour)}
	f := buildSessionForest([]*session{other, parent, child}, sessionParents([]*session{parent, child, other}, nil, nil))
	f.sortByRecent(func(s *session) time.Time { return when[s.ID] })
	if len(f.roots) != 2 || f.roots[0].ID != "p" || f.roots[1].ID != "o" {
		t.Fatalf("roots = %v, want the parent of the newest child first", ids(f.roots))
	}
	if got := f.recent["p"]; !got.Equal(now) {
		t.Fatalf("the parent's activity reads %v, want its child's %v", got, now)
	}
}

func ids(list []*session) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, s.ID)
	}
	return out
}

// A search keeps each match with the sessions above it, so a subagent found
// by name reads under the conversation that spawned it.
func TestSessionVisibleKeepsAncestors(t *testing.T) {
	top := sessionAt("top", "/x/1_top.jsonl", "")
	mid := sessionAt("mid", "/x/2_mid.jsonl", "/x/1_top.jsonl")
	leaf := sessionAt("leaf", "/x/3_leaf.jsonl", "/x/2_mid.jsonl")
	other := sessionAt("other", "/x/4_other.jsonl", "")
	list := []*session{top, mid, leaf, other}
	parents := sessionParents(list, nil, nil)
	visible := sessionVisible(list, parents, func(s *session) bool { return s.ID == "leaf" })
	for _, id := range []string{"leaf", "mid", "top"} {
		if !visible[id] {
			t.Fatalf("%q is missing from the search's context: %v", id, visible)
		}
	}
	if visible["other"] {
		t.Fatalf("an unrelated session showed: %v", visible)
	}
	if chain := sessionChain(parents, "leaf"); len(chain) != 2 || chain[0] != "top" || chain[1] != "mid" {
		t.Fatalf("chain = %v, want top then mid", chain)
	}
}

// The disclosure opens for what the user opened, for the path to the
// session on screen, and for every match of a search.
func TestRailOpenFollowsTheUserAndTheScreen(t *testing.T) {
	expanded := map[string]bool{"opened": true}
	if !railOpenFor(expanded, "opened", nil, false) {
		t.Fatal("a session the user opened reads folded")
	}
	if railOpenFor(expanded, "closed", nil, false) {
		t.Fatal("a session nobody opened reads open")
	}
	if !railOpenFor(nil, "above", []string{"above", "active"}, false) {
		t.Fatal("the path to the session on screen reads folded")
	}
	if !railOpenFor(nil, "anywhere", nil, true) {
		t.Fatal("a search hid a match behind a folded row")
	}
}
