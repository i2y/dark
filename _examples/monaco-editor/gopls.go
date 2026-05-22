// gopls.go bridges the Monaco editor's LSP client to a gopls subprocess.
// gopls speaks LSP over stdio; this proxy exposes it to the WebView over
// HTTP — SSE downstream (gopls -> browser) and POST upstream (browser -> gopls).
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// findGopls locates the gopls executable: PATH first, then GOPATH/bin and ~/go/bin.
func findGopls() (string, bool) {
	if p, err := exec.LookPath("gopls"); err == nil {
		return p, true
	}
	var candidates []string
	if out, err := exec.Command("go", "env", "GOPATH").Output(); err == nil {
		if gp := strings.TrimSpace(string(out)); gp != "" {
			candidates = append(candidates, filepath.Join(gp, "bin", "gopls"))
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, "go", "bin", "gopls"))
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, true
		}
	}
	return "", false
}

// lspProxy runs gopls as a subprocess and bridges LSP traffic between an HTTP
// transport (SSE downstream, POST upstream) and gopls's stdio.
type lspProxy struct {
	path string

	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex // serializes frames written to gopls stdin

	mu     sync.Mutex
	subs   map[int]chan []byte // SSE subscribers; key is subscriber id
	nextID int
}

func newLSPProxy(path string) *lspProxy {
	return &lspProxy{path: path, subs: make(map[int]chan []byte)}
}

// start launches gopls and pumps its stdout to subscribers.
func (p *lspProxy) start() error {
	cmd := exec.Command(p.path)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd, p.stdin = cmd, stdin
	go p.readLoop(stdout)
	return nil
}

// readLoop parses Content-Length-framed LSP messages from gopls and fans each
// out to every SSE subscriber as a single compact JSON line.
func (p *lspProxy) readLoop(stdout io.Reader) {
	r := bufio.NewReader(stdout)
	for {
		msg, err := readLSPMessage(r)
		if err != nil {
			if err != io.EOF {
				log.Printf("gopls: read error: %v", err)
			}
			return
		}
		var compact bytes.Buffer
		if json.Compact(&compact, msg) != nil {
			continue
		}
		p.broadcast(compact.Bytes())
	}
}

// readLSPMessage reads one Content-Length-framed message.
func readLSPMessage(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if name, value, ok := strings.Cut(line, ":"); ok &&
			strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			length, _ = strconv.Atoi(strings.TrimSpace(value))
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("gopls: message without Content-Length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

func (p *lspProxy) broadcast(msg []byte) {
	p.mu.Lock()
	chans := make([]chan []byte, 0, len(p.subs))
	for _, ch := range p.subs {
		chans = append(chans, ch)
	}
	p.mu.Unlock()
	for _, ch := range chans {
		select {
		case ch <- append([]byte(nil), msg...):
		default: // single local client; the buffer is large enough in practice
		}
	}
}

func (p *lspProxy) subscribe() (int, chan []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := p.nextID
	p.nextID++
	ch := make(chan []byte, 256)
	p.subs[id] = ch
	return id, ch
}

func (p *lspProxy) unsubscribe(id int) {
	p.mu.Lock()
	delete(p.subs, id)
	p.mu.Unlock()
}

// ServeStream is the SSE endpoint: it streams gopls -> browser messages.
func (p *lspProxy) ServeStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	id, ch := p.subscribe()
	defer p.unsubscribe(id)
	log.Print("lsp: client stream connected")
	defer log.Print("lsp: client stream closed")

	// Send a comment frame immediately: this flushes the response headers so
	// EventSource fires `open` right away. WebKit otherwise buffers a streaming
	// response that has sent no body yet, leaving the client stuck connecting.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case msg := <-ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// lspMethod extracts the JSON-RPC "method" from a message body, if any.
func lspMethod(body []byte) string {
	var m struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal(body, &m)
	return m.Method
}

// ServeSend is the POST endpoint: it forwards one browser -> gopls message.
func (p *lspProxy) ServeSend(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if m := lspMethod(body); m != "" && m != "textDocument/didChange" {
		log.Printf("lsp -> gopls: %s", m)
	}
	p.writeMu.Lock()
	_, err = fmt.Fprintf(p.stdin, "Content-Length: %d\r\n\r\n%s", len(body), body)
	p.writeMu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Close terminates the gopls subprocess.
func (p *lspProxy) Close() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}
