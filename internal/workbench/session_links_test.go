//go:build !js && !android && !ios

package workbench

import "testing"

func TestSessionLinksAreProfileBound(t *testing.T) {
	for raw, want := range map[string]string{
		"pideck-v2://session/123-ab":      "123-ab",
		"pideck-v2-dev://session/123-ab":  "",
		"pideck-v2://session/file%2Fone":  "",
		"pideck-v2://session/a?prompt=go": "",
		"pideck-v2://other/123-ab":        "",
	} {
		if got := sessionLinkID(raw, "pideck-v2"); got != want {
			t.Errorf("sessionLinkID(%q) = %q, want %q", raw, got, want)
		}
	}
}
