//go:build !js && !android && !ios

package workbench

// Scroll views that live under a Dynamic: a Dynamic rerun clears its whole
// subtree, so the new scroll view mounts at the top unless the offset is
// handed back. The stash itself is shared with the phone client (viewkit).

import (
	"example.com/pideck-v2/internal/viewkit"
)

// scrollbarGutter keeps content clear of overlay scrollbars at every nested scroll edge.
const scrollbarGutter = 16

// scrollStash is viewkit's stash, under the name this host uses.
type scrollStash = viewkit.ScrollStash

// scrollStashFor is the stash of the scroll view called key. It lives on the
// app, not in the builder: a Dynamic anywhere above the view reruns its
// builder, and a stash made fresh there would start at the top again.
func (a *app) scrollStashFor(key string) *scrollStash {
	if a.scrolls == nil {
		a.scrolls = viewkit.Stashes{}
	}
	return a.scrolls.For(key)
}

// forgetScrolls starts every settings scroll view at its top again, for a
// switch to a section whose content is different.
func (a *app) forgetScrolls(prefix string) {
	a.scrolls.Forget(prefix)
}
