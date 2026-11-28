package schedule

// Checks for the cron parser behind scheduled tasks: field ranges, names,
// the day-of-month/day-of-week rule, next occurrences and catch-up.

import (
	"testing"
	"time"
)

// TestParseTaskCron checks valid and invalid expressions.
func TestParseTaskCron(t *testing.T) {
	for _, expr := range []string{"0 9 * * *", "*/15 * * * *", "0 9 * * 1-5", "0 0 1 JAN *", "@daily", "30 8 * * MON"} {
		if _, err := Parse(expr); err != nil {
			t.Errorf("parseTaskCron(%q) = %v", expr, err)
		}
	}
	for _, expr := range []string{"", "0 9 * *", "0 24 * * *", "60 * * * *", "0 9 * * 8", "0 9 32 * *", "*/0 * * * *", "0 9 * * MON-FRI-"} {
		if _, err := Parse(expr); err == nil {
			t.Errorf("parseTaskCron(%q) accepted an invalid expression", expr)
		}
	}
}

// TestWeekdaySevenIsSunday checks ranges that end at 7, which cron treats
// as Sunday like 0.
func TestWeekdaySevenIsSunday(t *testing.T) {
	c, err := Parse("0 9 * * 6-7")
	if err != nil {
		t.Fatal(err)
	}
	if !c.dows[6] || !c.dows[0] || len(c.dows) != 2 {
		t.Errorf("weekdays = %v", c.dows)
	}
	c, err = Parse("0 9 * * 7")
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
	next, err := Next("0 9 * * *", now)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 17, 9, 0, 0, 0, loc)
	if !next.Equal(want) {
		t.Errorf("next daily = %v, want %v", next, want)
	}
	next, err = Next("*/15 * * * *", now)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 16, 10, 15, 0, 0, loc); !next.Equal(want) {
		t.Errorf("next quarter hour = %v, want %v", next, want)
	}
}

// TestNextTaskCronMidnight checks that exhausting the last hour's minutes
// advances to the following day, including month, year and leap-day boundaries.
func TestNextTaskCronMidnight(t *testing.T) {
	for _, tc := range []struct {
		name  string
		expr  string
		after time.Time
		want  time.Time
	}{
		{
			name: "hourly", expr: "0 * * * *",
			after: time.Date(2026, 11, 16, 23, 30, 0, 0, time.UTC),
			want:  time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "quarter hour at month end", expr: "*/15 * * * *",
			after: time.Date(2026, 11, 30, 23, 45, 0, 0, time.UTC),
			want:  time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "restricted hours at year end", expr: "0 0,23 * * *",
			after: time.Date(2026, 12, 31, 23, 0, 0, 0, time.UTC),
			want:  time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "leap day", expr: "0 * * * *",
			after: time.Date(2028, 2, 28, 23, 30, 0, 0, time.UTC),
			want:  time.Date(2028, 2, 29, 0, 0, 0, 0, time.UTC),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Next(tc.expr, tc.after)
			if err != nil {
				t.Fatal(err)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("Next(%q, %v) = %v, want %v", tc.expr, tc.after, got, tc.want)
			}
		})
	}
}

func TestLatestTaskOccurrenceAcrossMidnight(t *testing.T) {
	last := time.Date(2026, 11, 16, 23, 30, 0, 0, time.UTC)
	now := time.Date(2026, 11, 17, 0, 20, 0, 0, time.UTC)
	want := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	got, ok := LatestOccurrence("0 * * * *", last, now)
	if !ok || !got.Equal(want) {
		t.Fatalf("latest occurrence = %v, %v, want %v, true", got, ok, want)
	}
}

// TestNextTaskCronWeekday checks that a weekday field skips the weekend.
func TestNextTaskCronWeekday(t *testing.T) {
	loc := time.Local
	saturday := time.Date(2026, 11, 21, 8, 0, 0, 0, loc)
	next, err := Next("0 9 * * 1-5", saturday)
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
	next, err := Next("0 0 20 * 1", start)
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
	at, ok := LatestOccurrence("0 * * * *", last, now)
	if !ok {
		t.Fatal("no occurrence found")
	}
	if want := time.Date(2026, 11, 16, 12, 0, 0, 0, loc); !at.Equal(want) {
		t.Errorf("latest = %v, want %v", at, want)
	}
	if _, ok := LatestOccurrence("0 * * * *", last, last); ok {
		t.Error("an occurrence at the baseline was reported")
	}
}

// TestLatestTaskOccurrenceCoversFullWeek checks a per-minute task catches up
// to the latest missed minute across the full recovery window.
func TestLatestTaskOccurrenceCoversFullWeek(t *testing.T) {
	loc := time.Local
	last := time.Date(2026, 11, 16, 8, 0, 0, 0, loc)
	now := last.Add(7 * 24 * time.Hour)
	at, ok := LatestOccurrence("* * * * *", last, now)
	if !ok {
		t.Fatal("no occurrence found in the seven-day recovery window")
	}
	if !at.Equal(now) {
		t.Errorf("latest = %v, want %v", at, now)
	}
}

// TestTaskCronNeverMatches checks an impossible date ends rather than loops.
func TestTaskCronNeverMatches(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	next, err := Next("0 0 31 2 *", start)
	if err != nil {
		t.Fatal(err)
	}
	if !next.IsZero() {
		t.Errorf("Feb 31 matched: %v", next)
	}
}
