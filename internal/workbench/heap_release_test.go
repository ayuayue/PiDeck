//go:build !js && !android && !ios

package workbench

// When the app hands its idle heap back: often enough to stop a console peak
// from sitting in Task Manager, never mid-stream.

import (
	"runtime"
	"testing"
	"time"
)

func TestHeapReleaseDue(t *testing.T) {
	const mb = 1 << 20
	heap := func(idle, sys uint64) runtime.MemStats {
		return runtime.MemStats{HeapIdle: idle, HeapSys: sys}
	}
	cases := []struct {
		name    string
		mem     runtime.MemStats
		since   time.Duration
		running bool
		want    bool
	}{
		{"mostly idle", heap(900*mb, 1000*mb), 5 * time.Minute, false, true},
		{"exactly at the thresholds", heap(512*mb, 512*mb), 5 * time.Minute, false, true},
		{"nothing idle", heap(10*mb, 1000*mb), 5 * time.Minute, false, false},
		{"idle but a small share of the heap", heap(600*mb, 2000*mb), 5 * time.Minute, false, false},
		{"too little to be worth a pause", heap(400*mb, 400*mb), 5 * time.Minute, false, false},
		{"released too recently", heap(900*mb, 1000*mb), 30 * time.Second, false, false},
		{"a reply is streaming", heap(900*mb, 1000*mb), 5 * time.Minute, true, false},
		{"no heap at all", heap(0, 0), 5 * time.Minute, false, false},
	}
	for _, c := range cases {
		if got := heapReleaseDue(c.mem, c.since, heapReleaseEvery, c.running); got != c.want {
			t.Errorf("%s: heapReleaseDue(idle=%d sys=%d since=%v running=%v) = %v, want %v",
				c.name, c.mem.HeapIdle, c.mem.HeapSys, c.since, c.running, got, c.want)
		}
	}
}
