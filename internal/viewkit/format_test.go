package viewkit

// The counts both hosts print: a file's size and a session's cost read the
// same on the desktop and on the phone.

import "testing"

// TestFileSize guards the ladder a file list and a preview share: bytes,
// kilobytes, megabytes, and the gigabytes a large download reaches.
func TestFileSize(t *testing.T) {
	cases := map[int64]string{
		0:          "0 B",
		999:        "999 B",
		2048:       "2 KB",
		3 << 20:    "3.0 MB",
		1536 << 20: "1.5 GB",
		5 << 30:    "5.0 GB",
	}
	for size, want := range cases {
		if got := FileSize(size); got != want {
			t.Errorf("FileSize(%d) = %q, want %q", size, got, want)
		}
	}
}

// TestCredits guards the money a footer shows: a cost below a cent keeps its
// figures instead of rounding to nothing.
func TestCredits(t *testing.T) {
	cases := map[float64]string{
		0:      "$0",
		0.0037: "$0.0037",
		0.012:  "$0.01",
		4.2:    "$4.20",
	}
	for cost, want := range cases {
		if got := Credits(cost); got != want {
			t.Errorf("Credits(%v) = %q, want %q", cost, got, want)
		}
	}
}
