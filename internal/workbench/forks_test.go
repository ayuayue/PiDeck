//go:build !js && !android && !ios

package workbench

// Checks the fork family builder.

import (
	"testing"
)

func TestForkFamily(t *testing.T) {
	a := &app{cfg: config{
		ForkParents: map[string]string{"child": "parent", "grand": "child"},
		Titles:      map[string]string{"parent": "父", "child": "子", "grand": "孙"},
	}}
	nodes := a.forkFamily("child")
	if len(nodes) != 3 {
		t.Fatalf("nodes = %+v", nodes)
	}
	if nodes[0].ID != "parent" || nodes[0].Depth != 0 {
		t.Fatalf("root = %+v", nodes[0])
	}
	if nodes[1].ID != "child" || nodes[1].Depth != 1 || !nodes[1].Current {
		t.Fatalf("child = %+v", nodes[1])
	}
	if nodes[2].ID != "grand" || nodes[2].Depth != 2 {
		t.Fatalf("grand = %+v", nodes[2])
	}
	// A cycle is cut instead of walking forever.
	a.cfg.ForkParents = map[string]string{"a": "b", "b": "a"}
	if got := a.forkFamily("a"); len(got) > 2 {
		t.Fatalf("cycle = %+v", got)
	}
}
