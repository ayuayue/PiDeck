//go:build !js && !android && !ios

package sessionimport

import (
	"strings"
)

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// titleLine limits a source transcript's title to one line of n runes.
func titleLine(text string, n int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	text = strings.TrimSpace(strings.TrimLeft(text, "#>*-+ "))
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n]) + "…"
}
