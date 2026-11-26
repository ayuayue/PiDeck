//go:build !js && !android && !ios

package workbench

// The journal owns all disk access on one worker. Enqueueing a record never
// waits for disk; queries and cleanup join the same queue to preserve order.

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

const diagFileBackups = 4

var errDiagClosed = errors.New("log journal is closed")

type diagTask struct {
	event *diagEvent
	run   func(*diagFiles) error
	done  chan error
}

type diagJournal struct {
	mu      sync.Mutex
	pending []diagTask
	closed  bool
	failure error
	wake    chan struct{}
	done    chan struct{}
}

type diagFiles struct {
	path string
	file *os.File
	size int64
}

func newDiagJournal(path string) *diagJournal {
	j := &diagJournal{wake: make(chan struct{}, 1), done: make(chan struct{})}
	go j.work(&diagFiles{path: path})
	return j
}

func (j *diagJournal) enqueue(task diagTask) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return false
	}
	// A stalled disk must not consume unbounded memory. Report a gap to the
	// reader instead of blocking the interface or silently losing records.
	if task.event != nil && len(j.pending) >= 4096 {
		j.failure = errors.New("log queue is full; some records could not be saved")
		return false
	}
	j.pending = append(j.pending, task)
	select {
	case j.wake <- struct{}{}:
	default:
	}
	return true
}

func (j *diagJournal) append(ev diagEvent) { j.enqueue(diagTask{event: &ev}) }

func (j *diagJournal) work(files *diagFiles) {
	defer close(j.done)
	defer files.close()
	for {
		<-j.wake
		for {
			j.mu.Lock()
			tasks, closed := j.pending, j.closed
			j.pending = nil
			j.mu.Unlock()
			if len(tasks) == 0 {
				if closed {
					return
				}
				break
			}
			for _, task := range tasks {
				var err error
				if task.event != nil {
					err = files.append(*task.event)
					if err != nil {
						j.mu.Lock()
						j.failure = err
						j.mu.Unlock()
					}
				} else {
					err = task.run(files)
				}
				if task.done != nil {
					task.done <- err
				}
			}
		}
	}
}

// do is only used by background readers, tests and shutdown, never by UI
// event handlers. The worker completes every accepted task before closing.
func (j *diagJournal) do(fn func(*diagFiles) error) error {
	done := make(chan error, 1)
	if !j.enqueue(diagTask{run: fn, done: done}) {
		return errDiagClosed
	}
	return <-done
}

func (j *diagJournal) flush() error {
	return j.do(func(f *diagFiles) error {
		if f.file != nil {
			if err := f.file.Sync(); err != nil {
				return err
			}
		}
		j.mu.Lock()
		defer j.mu.Unlock()
		return j.failure
	})
}

func (j *diagJournal) close() {
	j.mu.Lock()
	j.closed = true
	select {
	case j.wake <- struct{}{}:
	default:
	}
	j.mu.Unlock()
	<-j.done
}

func (f *diagFiles) close() error {
	if f.file == nil {
		return nil
	}
	err := f.file.Close()
	f.file = nil
	return err
}

func (f *diagFiles) open() error {
	if f.file != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(f.path, os.O_CREATE|os.O_APPEND|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	f.file, f.size = file, info.Size()
	// A crash can leave an incomplete final line. Separate it from the next
	// record so one damaged entry cannot swallow the first new event.
	if f.size > 0 {
		var last [1]byte
		if _, err := file.ReadAt(last[:], f.size-1); err != nil {
			f.close()
			return err
		}
		if last[0] != '\n' {
			if _, err := file.Write([]byte{'\n'}); err != nil {
				f.close()
				return err
			}
			f.size++
		}
	}
	return nil
}

func (f *diagFiles) append(ev diagEvent) error {
	data, err := encodeDiagEvent(ev)
	if err != nil {
		return err
	}
	if err := f.open(); err != nil {
		return err
	}
	if f.size+int64(len(data)) > diagFileLimit {
		if err := f.rotate(); err != nil {
			return err
		}
	}
	n, err := f.file.Write(data)
	f.size += int64(n)
	return err
}

func (f *diagFiles) rotate() error {
	if err := f.close(); err != nil {
		return err
	}
	if err := os.Remove(fmt.Sprintf("%s.%d", f.path, diagFileBackups)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for i := diagFileBackups - 1; i >= 0; i-- {
		from := f.path
		if i > 0 {
			from += fmt.Sprintf(".%d", i)
		}
		if err := os.Rename(from, fmt.Sprintf("%s.%d", f.path, i+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return f.open()
}

func (f *diagFiles) paths() []string {
	out := []string{f.path}
	for i := 1; i <= diagFileBackups; i++ {
		out = append(out, fmt.Sprintf("%s.%d", f.path, i))
	}
	// Old text logs remain readable and can be cleaned through the same UI.
	legacy := filepath.Join(filepath.Dir(f.path), "pideck.log")
	return append(out, legacy, legacy+".1")
}

func readDiagLines(path string, visit func(string)) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 2*diagFileLimit {
		return fmt.Errorf("log file exceeds read limit: %s", filepath.Base(path))
	}
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 4096), 64<<10)
	for scan.Scan() {
		visit(scan.Text())
	}
	return scan.Err()
}

func (j *diagJournal) query(filter diagFilter, limit int) (diagResult, error) {
	var result diagResult
	err := j.do(func(f *diagFiles) error {
		var readErr error
		for _, path := range f.paths() {
			if err := readDiagLines(path, func(line string) {
				ev, ok := decodeDiagEvent(line)
				if !ok {
					result.Ignored++
					return
				}
				if filter.matches(ev) {
					result.Events = append(result.Events, ev)
				}
			}); err != nil {
				readErr = errors.Join(readErr, err)
			}
		}
		sort.SliceStable(result.Events, func(i, k int) bool { return result.Events[i].Time.After(result.Events[k].Time) })
		result.Total = len(result.Events)
		if limit <= 0 {
			limit = 100
		}
		if limit > 1000 {
			limit = 1000
		}
		if len(result.Events) > limit {
			result.Events = append([]diagEvent(nil), result.Events[:limit]...)
		}
		j.mu.Lock()
		defer j.mu.Unlock()
		return errors.Join(readErr, j.failure)
	})
	return result, err
}

func (j *diagJournal) clear(filter diagFilter) (int, error) {
	removed := 0
	err := j.do(func(f *diagFiles) error {
		if err := f.close(); err != nil {
			return err
		}
		for _, path := range f.paths() {
			var kept bytes.Buffer
			count := 0
			err := readDiagLines(path, func(line string) {
				ev, ok := decodeDiagEvent(line)
				if ok && filter.matches(ev) {
					count++
					return
				}
				kept.WriteString(line)
				kept.WriteByte('\n')
			})
			if err != nil {
				return err
			}
			if count == 0 {
				continue
			}
			if err := writeFileAtomic(path, kept.Bytes(), 0o600); err != nil {
				return err
			}
			removed += count
		}
		return nil
	})
	return removed, err
}
