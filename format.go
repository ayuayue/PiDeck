package main

// Numbers as a footer writes them: the workbench and the client show the
// same counts.

import (
	"fmt"
	"path"
	"strings"
	"time"
)

// credits renders a cost the way a footer does.
func credits(c float64) string {
	switch {
	case c <= 0:
		return "$0"
	case c < 0.01:
		return fmt.Sprintf("$%.4f", c)
	default:
		return fmt.Sprintf("$%.2f", c)
	}
}

// tokens shortens a token count.
func tokens(n int) string {
	switch {
	case n >= 999_500:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%.0fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// whenText is a short age for a list.
func whenText(t time.Time, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	return t.Format("1/2")
}

// firstLine shortens text to one line of at most n runes.
func firstLine(text string, n int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	text = strings.TrimSpace(strings.TrimLeft(text, "#>*-+ "))
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n]) + "…"
}

// splitGitPath splits a repository path into its name and its folder.
func splitGitPath(p string) (name, dir string) {
	dir, name = path.Split(strings.ReplaceAll(p, "\\", "/"))
	dir = strings.TrimSuffix(dir, "/")
	return name, dir
}
