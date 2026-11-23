package viewkit

// A scroll view under a Dynamic loses its place: a rerun clears the subtree,
// so the replacement mounts at the top. A stash lives beside the builder and
// hands the offset back once the rebuilt content has a height to clamp
// against. Both hosts keep one stash per scroll view, keyed by area and name.

import (
	"strings"

	"github.com/nsgo-dev/nsgo/core"
)

// ScrollStash remembers where one scroll view was.
type ScrollStash struct {
	ref     core.Ref
	at      core.Point
	restore bool
}

// Bind wraps sc so it keeps where the reader left it across a rebuild. The
// offset goes back after the rebuilt content has a height: on the first
// layout and once more on the next turns, which is when a scroll view that
// replaced another one accepts it.
func (s *ScrollStash) Bind(cx *core.Scope, sc core.Scroll) core.Scroll {
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

// Reset starts the view at its top again, for content that changed kind.
func (s *ScrollStash) Reset() {
	s.at = core.Point{}
	s.restore = false
	s.ref.ScrollTo(core.Point{}, false)
}

// Offset is where the reader left it.
func (s *ScrollStash) Offset() core.Point { return s.at }

// Stashes are one window's scroll stashes by key.
type Stashes map[string]*ScrollStash

// For is the stash called key, made on first use.
func (s Stashes) For(key string) *ScrollStash {
	if st := s[key]; st != nil {
		return st
	}
	st := &ScrollStash{}
	s[key] = st
	return st
}

// Forget starts every view whose key begins with prefix at its top again: a
// section that changes kind starts at its heading, not the last one's middle.
func (s Stashes) Forget(prefix string) {
	for key, st := range s {
		if strings.HasPrefix(key, prefix) {
			st.Reset()
			delete(s, key)
		}
	}
}
