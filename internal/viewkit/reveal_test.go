package viewkit

import (
	"strings"
	"testing"
)

func TestReveal(t *testing.T) {
	short := "先看预算，再看尾部。"
	if got, more := Reveal(short, 100); got != short || more {
		t.Fatalf("Reveal(short) = %q, %v", got, more)
	}
	long := strings.Repeat("想一个办法。", 100)
	head, more := Reveal(long, 40)
	if !more {
		t.Fatal("a 600-rune text should have more to show")
	}
	if n := len([]rune(head)); n > 41 {
		t.Fatalf("head = %d runes, want at most 41 with the ellipsis", n)
	}
	if !strings.HasSuffix(head, "…") {
		t.Fatalf("head should end with an ellipsis: %q", head)
	}
	if left := LeftOver(long, head); left <= 0 {
		t.Fatalf("LeftOver = %d, want the rest", left)
	}
	// A line break near the cut wins, so the head ends on a line.
	lines := strings.Repeat("一行推理。\n", 40)
	head, more = Reveal(lines, 40)
	if !more || strings.HasSuffix(strings.TrimSuffix(head, "…"), "一行推理") {
		t.Fatalf("head cut mid-line: %q", head)
	}
	if got, more := Reveal(long, 0); got != long || more {
		t.Fatal("a zero limit shows everything")
	}
}
