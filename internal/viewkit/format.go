package viewkit

// Numbers as a footer writes them: the workbench and the client show the
// same counts.

import (
	"fmt"
	"path"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
)

// credits renders a cost the way a footer does.
func Credits(c float64) string {
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
func Tokens(n int) string {
	switch {
	case n >= 999_500:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%.0fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// Duration renders how long a call took, as a process row shows it:
// milliseconds under a second, tenths of a second under a minute, then
// minutes and hours. The longest form is six figures cold ("59m59s"), which
// is the width of that row's time column, so the durations line up down a
// block. A row with no time to show leaves this empty and draws NoTime.
func Duration(d time.Duration) string {
	switch {
	case d < 0:
		return ""
	case d < time.Millisecond:
		return "0ms"
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

// FileSize says a file's size as a file manager does: one figure with its
// unit, so a list column stays narrow and readable whatever the file.
func FileSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// whenText is a short age for a list.
func WhenText(t time.Time, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return apptext.T("刚刚")
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
func FirstLine(text string, n int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	text = strings.TrimSpace(strings.TrimLeft(text, "#>*-+ "))
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n]) + "…"
}

// splitGitPath splits a repository path into its name and its folder.
func SplitGitPath(p string) (name, dir string) {
	dir, name = path.Split(strings.ReplaceAll(p, "\\", "/"))
	dir = strings.TrimSuffix(dir, "/")
	return name, dir
}
