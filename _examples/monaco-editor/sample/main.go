// Package main is a sample program for the Dark Code Editor.
//
// gopls powers the editing experience here: hover a symbol for its type and
// documentation, type "." after a value for completion, and press F12 on a
// symbol to jump to its definition.
package main

import (
	"fmt"
	"strings"
	"time"
)

// Task is a single to-do item with an optional due date.
type Task struct {
	Title string
	Done  bool
	Due   time.Time
}

// Summary returns a one-line, human-readable description of the task.
func (t Task) Summary() string {
	status := "pending"
	if t.Done {
		status = "done"
	}
	return fmt.Sprintf("[%s] %s (due %s)", status, t.Title, t.Due.Format("2006-01-02"))
}

func main() {
	tasks := []Task{
		{Title: "Wire up gopls", Done: true, Due: time.Now()},
		{Title: "Try code completion", Done: false, Due: time.Now().Add(48 * time.Hour)},
	}

	var b strings.Builder
	for i, t := range tasks {
		fmt.Fprintf(&b, "%d. %s\n", i+1, t.Summary())
	}
	fmt.Print(b.String())

	// Uncomment the line below — gopls will flag the type mismatch:
	// var count int = "three"
}
