package viewkit

// Showing a long piece of reasoning without drowning the page: the head
// of it, and whether the rest is one press away.

import "strings"

// Reveal is text's head of at most limit runes, closed with an ellipsis
// when anything is left out, and whether the caller should offer the rest.
// The cut backs up to a line break when one falls in the last quarter, so
// a line of prose is not sliced mid-word.
func Reveal(text string, limit int) (string, bool) {
	if limit <= 0 {
		return text, false
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text, false
	}
	head := strings.TrimRight(string(runes[:limit]), " \t\n")
	if cut := strings.LastIndexByte(head, '\n'); cut > len(head)*3/4 {
		head = strings.TrimRight(head[:cut], " \t\n")
	}
	if head == "" {
		return "…", true
	}
	return head + "…", true
}

// LeftOver is how many runes of text Reveal left out, for the press that
// shows them.
func LeftOver(text, shown string) int {
	left := len([]rune(text)) - len([]rune(shown))
	if left < 0 {
		return 0
	}
	return left
}
