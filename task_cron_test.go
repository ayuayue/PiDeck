package main

// Checks for the cron parser behind scheduled tasks: field ranges, names,
// the day-of-month/day-of-week rule, next occurrences and catch-up.

import (
	"testing"
	"time"
)

// TestParseTaskCron checks valid and invalid expressions.
func TestParseTaskCron(t *testing.T) {
	for _, expr := range []string{"0 9 * * *", "*/15 * * * *", "0 9 * * 1-5", "0 0 1 JAN *", "@daily", "30 8 * * MON"} {
		if _, err := parseTaskCron(expr); err != nil {
			t.Errorf("parseTaskCron(%q) = %v", expr, err)
		}
	}
	for _, expr := range []string{"", "0 9 * *", "0 24 * * *", "60 * * * *", "0 9 * * 8", "0 9 32 * *", "*/0 * * * *", "0 9 * * MON-FRI-"} {
		if _, err := parseTaskCron(expr); err == nil {
			t.Errorf("parseTaskCron(%q) accepted an invalid expression", expr)
		}
	}
}

// TestWeekdaySevenIsSunday checks ranges that end at 7, which cron treats
// as Sunday like 0.
func TestWeekdaySevenIsSunday(t *testing.T) {
	c, err := parseTaskCron("0 9 * * 6-7")
	if err != nil {
		t.Fatal(err)
	}
	if !c.dows[6] || !c.dows[0] || len(c.dows) != 2 {
		t.Errorf("weekdays = %v", c.dows)
	}
	c, err = parseTaskCron("0 9 * * 7")
	if err != nil {
		t.Fatal(err)
	}
	if !c.dows[0] || len(c.dows) != 1 {
		t.Errorf("Sunday = %v", c.dows)
	}
}

// TestNextTaskCron checks the next occurrence in local time.
func TestNextTaskCron(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 11, 16, 10, 5, 0, 0, loc) // Monday
	next, err := nextTaskCron("0 9 * * *", now)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 17, 9, 0, 0, 0, loc)
	if !next.Equal(want) {
		t.Errorf("next daily = %v, want %v", next, want)
	}
	next, err = nextTaskCron("*/15 * * * *", now)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 16, 10, 15, 0, 0, loc); !next.Equal(want) {
		t.Errorf("next quarter hour = %v, want %v", next, want)
	}
}

// TestNextTaskCronWeekday checks that a weekday field skips the weekend.
func TestNextTaskCronWeekday(t *testing.T) {
	loc := time.Local
	saturday := time.Date(2026, 11, 21, 8, 0, 0, 0, loc)
	next, err := nextTaskCron("0 9 * * 1-5", saturday)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 23, 9, 0, 0, 0, loc) // Monday
	if !next.Equal(want) {
		t.Errorf("weekday schedule = %v, want %v", next, want)
	}
}

// TestNextTaskCronDayRule checks the OR rule when both day fields are set.
func TestNextTaskCronDayRule(t *testing.T) {
	loc := time.Local
	start := time.Date(2026, 11, 16, 0, 0, 0, 0, loc) // Monday, the 16th
	// "the 20th, or any Monday": the next day after the 16th is the 20th
	// (Friday), even though Monday comes later.
	next, err := nextTaskCron("0 0 20 * 1", start)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 20, 0, 0, 0, 0, loc); !next.Equal(want) {
		t.Errorf("day rule = %v, want %v", next, want)
	}
}

// TestLatestTaskOccurrence checks catch-up only runs the newest miss.
func TestLatestTaskOccurrence(t *testing.T) {
	loc := time.Local
	last := time.Date(2026, 11, 16, 8, 0, 0, 0, loc)
	now := time.Date(2026, 11, 16, 12, 30, 0, 0, loc)
	at, ok := latestTaskOccurrence("0 * * * *", last, now)
	if !ok {
		t.Fatal("no occurrence found")
	}
	if want := time.Date(2026, 11, 16, 12, 0, 0, 0, loc); !at.Equal(want) {
		t.Errorf("latest = %v, want %v", at, want)
	}
	if _, ok := latestTaskOccurrence("0 * * * *", last, last); ok {
		t.Error("an occurrence at the baseline was reported")
	}
}

// TestTaskCronNeverMatches checks an impossible date ends rather than loops.
func TestTaskCronNeverMatches(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	next, err := nextTaskCron("0 0 31 2 *", start)
	if err != nil {
		t.Fatal(err)
	}
	if !next.IsZero() {
		t.Errorf("Feb 31 matched: %v", next)
	}
}
