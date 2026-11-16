package main

// Numbers as the transcript writes them: the workbench's footer and the
// client's composer show the same counts.

import "fmt"

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
