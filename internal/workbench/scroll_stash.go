//go:build !js && !android && !ios

package workbench

// Scroll views that live under a Dynamic: a Dynamic rerun clears its whole
// subtree, so the new scroll view mounts at the top unless the offset is
// handed back. A stash beside the builder - not inside the closure - survives
// those reruns and puts the offset back once the rebuilt content has a height
// to clamp against.

import (
	"strings"

	"github.com/nsgo-dev/nsgo/core"
)

// scrollStash remembers where one scroll view was.
type scrollStash struct {
	ref     core.Ref
	at      core.Point
	restore bool
}

// bind wraps sc so it keeps where the reader left it across a rebuild. The
// offset goes back after the rebuilt content has a height: on the first
// layout and once more on the next turns, which is when a scroll view that
// replaced another one accepts it.
func (s *scrollStash) bind(cx *core.Scope, sc core.Scroll) core.Scroll {
	s.restore = s.at.Y > 0
	at := s.at
	sc.Ref = &s.ref
	sc.OnScroll = func(e core.ScrollEvent) {
		// Stale is the platform repeating an offset on its way elsewhere,
		// and what it reports while we put the old one back is not the
		// reader moving.
		if e.Stale || s.restore {
			return
		}
		s.at = e.Offset
	}
	sc.OnLayout = func(core.Bounds) {
		if !s.restore {
			return
		}
		s.ref.ScrollTo(at, false)
	}
	if s.restore {
		cx.AfterFunc(0, func() {
			if s.restore {
				s.ref.ScrollTo(at, false)
			}
		})
		cx.AfterFunc(0, func() {
			if s.restore {
				s.restore = false
				s.ref.ScrollTo(at, false)
			}
		})
	}
	return sc
}

// reset starts the view at its top again, for content that changed kind.
func (s *scrollStash) reset() {
	s.at = core.Point{}
	s.restore = false
	s.ref.ScrollTo(core.Point{}, false)
}

// offset is where the reader left it.
func (s *scrollStash) offset() core.Point { return s.at }

// scrollStashFor is the stash of the scroll view called key. It lives on the
// app, not in the builder: a Dynamic anywhere above the view reruns its
// builder, and a stash made fresh there would start at the top again.
func (a *app) scrollStashFor(key string) *scrollStash {
	if a.scrolls == nil {
		a.scrolls = map[string]*scrollStash{}
	}
	if st := a.scrolls[key]; st != nil {
		return st
	}
	st := &scrollStash{}
	a.scrolls[key] = st
	return st
}

// forgetScrolls does that for every view whose key begins with prefix: a
// section that changes kind starts at its heading, not at the last one's
// middle.
func (a *app) forgetScrolls(prefix string) {
	for key, st := range a.scrolls {
		if strings.HasPrefix(key, prefix) {
			st.reset()
			delete(a.scrolls, key)
		}
	}
}
