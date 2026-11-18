//go:build !js && !android && !ios

package workbench

// Checks for the desktop pet's mood.

import (
	"testing"
)

// TestPetMoodOf checks running wins over failed, and idle has neither.
func TestPetMoodOf(t *testing.T) {
	cases := []struct {
		statuses []sessionStatus
		mood     petMood
		n        int
	}{
		{nil, petIdle, 0},
		{[]sessionStatus{statusIdle}, petIdle, 0},
		{[]sessionStatus{statusRunning, statusStarting}, petBusy, 2},
		{[]sessionStatus{statusFailed, statusRunning}, petBusy, 1},
		{[]sessionStatus{statusFailed, statusFailed}, petFailed, 2},
	}
	for _, c := range cases {
		mood, n := petMoodOf(c.statuses)
		if mood != c.mood || n != c.n {
			t.Errorf("petMoodOf(%v) = %v, %d; want %v, %d", c.statuses, mood, n, c.mood, c.n)
		}
	}
}
