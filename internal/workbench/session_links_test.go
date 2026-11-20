package workbench

import "testing"

func TestSessionLinksAreProfileBound(t *testing.T) {
	for raw, want := range map[string]string{
		"pideck-lite://session/123-ab":      "123-ab",
		"pideck-lite-dev://session/123-ab":  "",
		"pideck-lite://session/file%2Fone":  "",
		"pideck-lite://session/a?prompt=go": "",
		"pideck-lite://other/123-ab":        "",
	} {
		if got := sessionLinkID(raw, "pideck-lite"); got != want {
			t.Errorf("sessionLinkID(%q) = %q, want %q", raw, got, want)
		}
	}
}
