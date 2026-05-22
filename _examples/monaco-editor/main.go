// Command monaco-editor is a dark desktop app that embeds the Monaco Editor
// (the code editor that powers VS Code) inside a native window, with Go
// language intelligence provided by gopls.
//
// Monaco is loaded client-side via its AMD loader from vendored static files
// that dark serves same-origin. gopls runs as a subprocess; its LSP traffic is
// bridged to the WebView over SSE (downstream) and POST (upstream).
//
// Run `make vendor` once to download Monaco into public/vs/, then `go run .`.
// Go intelligence additionally requires gopls on PATH (or in GOPATH/bin):
//
//	go install golang.org/x/tools/gopls@latest
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/i2y/dark"
	"github.com/i2y/dark/desktop"
)

func init() { runtime.LockOSThread() }

func main() {
	// Monaco must be vendored first (see README.md).
	if _, err := os.Stat(filepath.Join("public", "vs", "loader.js")); err != nil {
		log.Fatal("Monaco is not vendored: run `make vendor` first (see README.md)")
	}

	// The sample Go module opened by default; gopls uses it as the workspace.
	sampleDir, err := filepath.Abs("sample")
	if err != nil {
		log.Fatal(err)
	}
	sampleFile := filepath.Join(sampleDir, "main.go")

	app, err := dark.New(
		dark.WithLayout("layouts/default.tsx"),
		dark.WithTemplateDir("views"),
	)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()

	app.Use(dark.Logger())
	app.Island("editor", "islands/editor.tsx")
	app.Static("/vs", "public/vs")

	app.Get("/", dark.Route{
		Component: "pages/index.tsx",
		Loader: func(ctx dark.Context) (any, error) {
			content, err := os.ReadFile(sampleFile)
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"content":  string(content),
				"filename": "main.go",
				"path":     sampleFile,
				"language": "go",
			}, nil
		},
	})

	// Compose the dark app with the gopls LSP transport. dark exposes no raw
	// handler hook, so /lsp/* routes live on an outer mux; everything else
	// falls through to the dark app.
	mux := http.NewServeMux()
	if goplsPath, ok := findGopls(); ok {
		proxy := newLSPProxy(goplsPath)
		if err := proxy.start(); err != nil {
			log.Printf("gopls: failed to start (%v) — Go intelligence disabled", err)
		} else {
			defer proxy.Close()
			log.Printf("gopls: started (%s)", goplsPath)
			mux.HandleFunc("GET /lsp/stream", proxy.ServeStream)
			mux.HandleFunc("POST /lsp/send", proxy.ServeSend)
		}
	} else {
		log.Print("gopls: not found — Go intelligence disabled " +
			"(install: go install golang.org/x/tools/gopls@latest)")
	}
	mux.Handle("/", app.MustHandler())

	dsk := desktop.New(mux,
		desktop.WithTitle("Dark Code Editor"),
		desktop.WithSize(1100, 750),
		desktop.WithMinSize(700, 500),
		desktop.WithDebug(true),
		desktop.WithOnReady(func(url string) {
			fmt.Println("Dark Code Editor running at", url)
		}),
	)

	// read_file / write_file: the native dialogs (window.dark.openFile /
	// saveFile) yield only a path; Go does the actual file I/O.
	dsk.Bind("read_file", func(path string) (map[string]any, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"path":    path,
			"name":    filepath.Base(path),
			"content": string(data),
		}, nil
	})
	dsk.Bind("write_file", func(path, content string) error {
		return os.WriteFile(path, []byte(content), 0o644)
	})

	if err := dsk.Run(); err != nil {
		log.Fatal(err)
	}
}
