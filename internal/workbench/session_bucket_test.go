//go:build !js && !android && !ios

package workbench

import (
	"slices"
	"testing"
	"time"
)

// Mixed UTC file timestamps and local activity must share one heading for
// each local date, even around midnight on either side of UTC.
func TestSessionBucketsUseDisplayTimezone(t *testing.T) {
	for _, offset := range []int{8, -8, 0} {
		loc := time.FixedZone("display", offset*60*60)
		now := time.Date(2026, 11, 27, 1, 0, 0, 0, loc)
		if offset < 0 {
			now = time.Date(2026, 11, 27, 23, 0, 0, 0, loc)
		}
		t.Run(now.Format("-0700"), func(t *testing.T) {
			list := []*session{
				{ID: "today-utc-first"}, {ID: "today-local"}, {ID: "today-utc-last"},
				{ID: "yesterday-utc-first"}, {ID: "yesterday-local"}, {ID: "yesterday-utc-last"},
			}
			when := make(map[string]time.Time, len(list))
			for i, s := range list {
				day := i / 3
				at := now.AddDate(0, 0, -day).Add(-time.Duration(i%3+1) * 10 * time.Minute)
				if i%3 != 1 {
					at = at.UTC()
				}
				when[s.ID] = at
			}
			groups := sessionBucketsBy(list, now, func(s *session) time.Time { return when[s.ID] })
			if len(groups) != 2 {
				labels := make([]string, 0, len(groups))
				for _, group := range groups {
					labels = append(labels, group.Label)
				}
				t.Fatalf("headings = %v, want one 今天 and one 昨天", labels)
			}
			for i, label := range []string{"今天", "昨天"} {
				if groups[i].Label != label || !slices.Equal(groups[i].Rows, list[i*3:(i+1)*3]) {
					t.Errorf("group %d = %q %v, want %q %v", i, groups[i].Label, ids(groups[i].Rows), label, ids(list[i*3:(i+1)*3]))
				}
			}
		})
	}
}

// Yesterday means the previous calendar date, including 23- and 25-hour
// days when a display timezone enters or leaves daylight saving time.
func TestSessionBucketsUseCalendarYesterday(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		now  time.Time
	}{
		{"spring forward", time.Date(2026, 3, 9, 0, 30, 0, 0, loc)},
		{"fall back", time.Date(2026, 11, 1, 23, 30, 0, 0, loc)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			yesterday := tc.now.AddDate(0, 0, -1)
			at := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 12, 0, 0, 0, loc)
			groups := sessionBucketsBy([]*session{{ID: "yesterday"}}, tc.now, func(*session) time.Time { return at })
			if len(groups) != 1 || groups[0].Label != "昨天" {
				t.Fatalf("groups = %v, want 昨天 for %v at %v", groups, at, tc.now)
			}
		})
	}
}
