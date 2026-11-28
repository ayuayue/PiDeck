package schedule

// Cron expressions for scheduled tasks: five fields (minute, hour, day of
// month, month, day of week), with lists, ranges and steps. Month and
// weekday names work as well. Matching follows the traditional cron rule:
// when both the day of month and the day of week are restricted, either
// may match.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// maxLatestOccurrenceSteps covers every minute in the scheduler's seven-day
// recovery window; older tasks are skipped before this helper is called.
const maxLatestOccurrenceSteps = 7 * 24 * 60

// taskCron is one parsed expression.
type Schedule struct {
	minutes map[int]bool
	hours   map[int]bool
	doms    map[int]bool
	months  map[int]bool
	dows    map[int]bool
	domAny  bool
	dowAny  bool
	// text is the normalized expression, for comparing two schedules.
	text string
}

var (
	monthNames = map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
	dayNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
)

// parseTaskCron reads one expression.
func Parse(expr string) (*Schedule, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, fmt.Errorf("表达式是空的")
	}
	switch strings.ToLower(expr) {
	case "@yearly", "@annually":
		expr = "0 0 1 1 *"
	case "@monthly":
		expr = "0 0 1 * *"
	case "@weekly":
		expr = "0 0 * * 0"
	case "@daily", "@midnight":
		expr = "0 0 * * *"
	case "@hourly":
		expr = "0 * * * *"
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return nil, fmt.Errorf("需要 5 段：分 时 日 月 周")
	}
	c := &Schedule{minutes: map[int]bool{}, hours: map[int]bool{}, doms: map[int]bool{},
		months: map[int]bool{}, dows: map[int]bool{}, text: strings.Join(fields, " ")}
	var err error
	if c.minutes, _, err = parseCronField(fields[0], 0, 59, nil, false); err != nil {
		return nil, fmt.Errorf("分钟：%w", err)
	}
	if c.hours, _, err = parseCronField(fields[1], 0, 23, nil, false); err != nil {
		return nil, fmt.Errorf("小时：%w", err)
	}
	if c.doms, c.domAny, err = parseCronField(fields[2], 1, 31, nil, false); err != nil {
		return nil, fmt.Errorf("日：%w", err)
	}
	if c.months, _, err = parseCronField(fields[3], 1, 12, monthNames, false); err != nil {
		return nil, fmt.Errorf("月：%w", err)
	}
	if c.dows, c.dowAny, err = parseCronField(fields[4], 0, 6, dayNames, true); err != nil {
		return nil, fmt.Errorf("周：%w", err)
	}
	return c, nil
}

// parseCronField reads one field into its allowed values. Names replace
// numbers when given; weekday 7 means Sunday.
func parseCronField(field string, min, max int, names map[string]int, weekday bool) (map[int]bool, bool, error) {
	out := map[int]bool{}
	any := strings.TrimSpace(field) == "*"
	// Weekday ranges may end at 7, which is Sunday like 0.
	limit := max
	if weekday {
		limit = 7
	}
	for _, part := range strings.Split(field, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, false, fmt.Errorf("空的项")
		}
		step := 1
		body := part
		if i := strings.Index(body, "/"); i >= 0 {
			n, err := strconv.Atoi(strings.TrimSpace(body[i+1:]))
			if err != nil || n <= 0 {
				return nil, false, fmt.Errorf("步长 %q 不是正整数", body[i+1:])
			}
			step = n
			body = strings.TrimSpace(body[:i])
		}
		lo, hi := min, limit
		switch {
		case body == "*" || body == "":
			// The whole range.
		case strings.Contains(body, "-"):
			halves := strings.SplitN(body, "-", 2)
			var err error
			lo, err = cronNumber(halves[0], names)
			if err != nil {
				return nil, false, err
			}
			hi, err = cronNumber(halves[1], names)
			if err != nil {
				return nil, false, err
			}
			if lo > hi {
				return nil, false, fmt.Errorf("范围 %q 反了", body)
			}
		default:
			n, err := cronNumber(body, names)
			if err != nil {
				return nil, false, err
			}
			lo, hi = n, n
			if step > 1 {
				hi = limit
			}
		}
		if lo < min || hi > limit {
			return nil, false, fmt.Errorf("%d–%d 超出 %d–%d", lo, hi, min, limit)
		}
		for raw := lo; raw <= hi; raw += step {
			v := raw
			if weekday {
				v %= 7
			}
			out[v] = true
		}
	}
	if len(out) == 0 {
		return nil, false, fmt.Errorf("没有可用的值")
	}
	return out, any, nil
}

// cronNumber reads a number or a name.
func cronNumber(text string, names map[string]int) (int, error) {
	text = strings.TrimSpace(strings.ToLower(text))
	if names != nil {
		if v, ok := names[text]; ok {
			return v, nil
		}
	}
	n, err := strconv.Atoi(text)
	if err != nil {
		return 0, fmt.Errorf("%q 不是数字", text)
	}
	return n, nil
}

// dayMatches applies the day-of-month / day-of-week rule.
func (c *Schedule) dayMatches(t time.Time) bool {
	dom := c.doms[t.Day()]
	dow := c.dows[int(t.Weekday())]
	switch {
	case c.domAny && c.dowAny:
		return true
	case c.domAny:
		return dow
	case c.dowAny:
		return dom
	default:
		return dom || dow
	}
}

// nextTaskCron returns the first occurrence strictly after after.
func Next(expr string, after time.Time) (time.Time, error) {
	c, err := Parse(expr)
	if err != nil {
		return time.Time{}, err
	}
	return c.next(after), nil
}

// next finds the next matching minute.
func (c *Schedule) next(after time.Time) time.Time {
	loc := after.Location()
	if loc == nil {
		loc = time.Local
	}
	candidate := after.Truncate(time.Minute).Add(time.Minute)
	// Five years comfortably covers yearly schedules and leap years; a
	// value like "0 0 31 2 *" never matches and ends here.
	for day := 0; day < 366*5+2; day++ {
		if !c.months[int(candidate.Month())] {
			candidate = time.Date(candidate.Year(), candidate.Month()+1, 1, 0, 0, 0, 0, loc)
			continue
		}
		if !c.dayMatches(candidate) {
			candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day()+1, 0, 0, 0, 0, loc)
			continue
		}
		h := candidate.Hour()
		if !c.hours[h] {
			nextHour := -1
			for x := h + 1; x < 24; x++ {
				if c.hours[x] {
					nextHour = x
					break
				}
			}
			if nextHour < 0 {
				candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day()+1, 0, 0, 0, 0, loc)
				continue
			}
			candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day(), nextHour, 0, 0, 0, loc)
			h = nextHour
		}
		m := candidate.Minute()
		if !c.minutes[m] {
			nextMinute := -1
			for x := m + 1; x < 60; x++ {
				if c.minutes[x] {
					nextMinute = x
					break
				}
			}
			if nextMinute < 0 {
				candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day(), h+1, 0, 0, 0, loc)
				continue
			}
			candidate = time.Date(candidate.Year(), candidate.Month(), candidate.Day(), h, nextMinute, 0, 0, loc)
		}
		return candidate
	}
	return time.Time{}
}

// latestTaskOccurrence is the newest occurrence in (after, now]. Only the
// latest is run after a gap; the older ones are skipped by design.
func LatestOccurrence(expr string, after, now time.Time) (time.Time, bool) {
	c, err := Parse(expr)
	if err != nil {
		return time.Time{}, false
	}
	at := c.next(after)
	if at.IsZero() || at.After(now) {
		return time.Time{}, false
	}
	for i := 0; i < maxLatestOccurrenceSteps; i++ {
		nx := c.next(at)
		if nx.IsZero() || nx.After(now) {
			break
		}
		at = nx
	}
	return at, true
}
