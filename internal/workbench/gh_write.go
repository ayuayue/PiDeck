//go:build !js && !android && !ios

package workbench

// The writes the review pane and the phone both run: one gh command per
// action, built here so the pane, the API and the tests agree on its
// arguments.

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// The writes an item accepts.
const (
	reviewActComment = "comment"
	reviewActMerge   = "merge"
	reviewActClose   = "close"
	reviewActReopen  = "reopen"
	reviewActReview  = "review"
)

// The verdicts a pull request review can carry.
const (
	verdictApprove        = "approve"
	verdictRequestChanges = "request-changes"
	verdictComment        = "comment"
)

// reviewCommand builds the gh command one write runs: its arguments, and
// the body piped to its standard input.
func reviewCommand(kind string, number int, action, method, body string) ([]string, string, error) {
	if number <= 0 {
		return nil, "", errors.New("缺少编号")
	}
	numberText := strconv.Itoa(number)
	if kind != reviewIssue {
		kind = reviewPR
	}
	body = strings.TrimSpace(body)
	switch action {
	case reviewActComment:
		if body == "" {
			return nil, "", errors.New("评论不能为空")
		}
		return []string{kind, "comment", numberText, "--body-file", "-"}, body, nil
	case reviewActClose, reviewActReopen:
		return []string{kind, action, numberText}, "", nil
	case reviewActMerge:
		if kind != reviewPR {
			return nil, "", errors.New("只有拉取请求能合并")
		}
		flag := "--squash"
		switch method {
		case "merge":
			flag = "--merge"
		case "rebase":
			flag = "--rebase"
		}
		return []string{"pr", "merge", numberText, flag}, "", nil
	case reviewActReview:
		if kind != reviewPR {
			return nil, "", errors.New("只有拉取请求能提交评审")
		}
		flag := "--approve"
		switch method {
		case verdictRequestChanges:
			flag = "--request-changes"
		case verdictComment:
			flag = "--comment"
		case verdictApprove:
		default:
			return nil, "", errors.New("不认识的评审结论")
		}
		args := []string{"pr", "review", numberText, flag}
		if body == "" {
			if flag != "--approve" {
				return nil, "", errors.New("这个结论需要写一段说明")
			}
			return args, "", nil
		}
		return append(args, "--body-file", "-"), body, nil
	}
	return nil, "", errors.New("不认识的操作")
}

// runReviewWrite runs one write on a project folder and turns gh's
// refusal into a line the user can act on.
func runReviewWrite(t target, path, kind string, number int, action, method, body string) error {
	args, stdin, err := reviewCommand(kind, number, action, method, body)
	if err != nil {
		return err
	}
	_, stderr, code, err := ghRunIn(t, path, 120*time.Second, stdin, args...)
	if err != nil {
		return err
	}
	if code != 0 {
		return errors.New(ghMessage(stderr, code))
	}
	return nil
}
