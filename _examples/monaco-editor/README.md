# Monaco Editor — dark desktop

A native desktop code editor built with **dark** and the **Monaco Editor** (the
editor that powers VS Code), with **Go language intelligence via gopls**.

## Run

Monaco ships as a large prebuilt bundle, so it is vendored once instead of being
committed to the repo:

```sh
make vendor   # downloads Monaco into public/vs/ (needs npm + network)
go run .
```

The editor opens `sample/main.go`. Full Go intelligence additionally requires
gopls (see below); without it the editor still works with syntax highlighting.

## How it works

dark's Island/esbuild pipeline cannot bundle Monaco directly: Monaco needs
separate Web Worker files and ships `.ttf` font assets, neither of which the
island bundler emits. Instead this example uses Monaco's official **AMD loader**:

- `make vendor` copies `monaco-editor/min/vs` into `public/vs/`.
- `main.go` serves it same-origin with `app.Static("/vs", "public/vs")`.
- The layout loads `<script src="/vs/loader.js">`; the editor Island calls
  `require(['vs/editor/editor.main'])` in a `useEffect`.

Because everything is served from one origin (`http://127.0.0.1:<port>`, dark
desktop's embedded server) and dark sets no CSP, Monaco's language workers,
fonts, and CSS all load with no extra configuration. **dark itself is unmodified.**

Native **Open** / **Save** use the desktop file dialogs (`window.dark.openFile` /
`saveFile`) plus two Go↔JS bindings (`read_file` / `write_file`) for file I/O.

## Go intelligence (gopls)

Monaco ships worker-backed language services only for TS/JS, JSON, CSS and HTML.
To make Go code just as smart — semantic completion, hover, type diagnostics,
go-to-definition, signature help and gofmt formatting — this example runs
**gopls**, the Go language server, as a subprocess.

Prerequisite:

```sh
go install golang.org/x/tools/gopls@latest
```

gopls speaks LSP over stdio. `gopls.go` bridges it to the WebView over HTTP:
gopls → browser on an SSE stream (`GET /lsp/stream`), browser → gopls via
`POST /lsp/send`. Those two routes live on an `http.ServeMux` that otherwise
delegates to the dark app — `desktop.New` accepts any `http.Handler`. On the
client, `views/islands/lsp.ts` is a thin LSP client that wires gopls responses
into Monaco's `languages.*` provider APIs.

If gopls is not installed the editor still runs (highlighting only) and the
status bar shows `gopls: unavailable`.

## Platforms

Runs on macOS, Linux, and Windows. On Windows, build with `-tags qjswasm` — the
same tag that `dark package windows` applies automatically.
