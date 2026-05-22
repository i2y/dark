// lsp.ts — a thin LSP client connecting the Monaco editor to a gopls
// subprocess. The Go side bridges gopls over SSE (downstream) + POST
// (upstream); this module speaks JSON-RPC over that transport and wires the
// results into Monaco's language provider APIs.

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export type LSPStatus = 'connecting' | 'indexing' | 'ready' | 'unavailable';

const STREAM_URL = '/lsp/stream';
const SEND_URL = '/lsp/send';

// pathToUri converts an absolute filesystem path to a file:// URI.
function pathToUri(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export class GoLSP {
  private monaco: any;
  private onStatus: (s: LSPStatus) => void;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sendQueue: Promise<any> = Promise.resolve();

  private initialized = false;
  private initOnce: Promise<void> | null = null;
  private failed = false;

  // The single active Go document.
  private docUri = '';
  private docVersion = 0;
  private model: any = null;
  private changeSub: any = null;
  private changeTimer: any = null;

  constructor(monaco: any, onStatus: (s: LSPStatus) => void) {
    this.monaco = monaco;
    this.onStatus = onStatus;
    this.registerProviders();
  }

  // --- transport -----------------------------------------------------------

  // connect opens the SSE stream and resolves once it is established (so the
  // server-side subscriber is registered before we send anything).
  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const es = new EventSource(STREAM_URL);
      es.onopen = () => resolve();
      es.onmessage = (e) => {
        try {
          this.handleIncoming(JSON.parse(e.data));
        } catch (_) {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        // The stream 404s when gopls is unavailable (routes not registered).
        if (!this.initialized) {
          this.failed = true;
          this.onStatus('unavailable');
          es.close();
          resolve();
        }
      };
    });
  }

  // post sends one JSON-RPC message, serialized so order is preserved.
  private post(msg: any) {
    const body = JSON.stringify(msg);
    this.sendQueue = this.sendQueue.then(() =>
      fetch(SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  private request(method: string, params: any): Promise<any> {
    if (this.failed) return Promise.reject(new Error('lsp unavailable'));
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.post({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  private notify(method: string, params: any) {
    if (this.failed) return;
    this.post({ jsonrpc: '2.0', method, params });
  }

  private handleIncoming(msg: any) {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
      return;
    }
    // Request from the server — we must reply, or gopls may stall.
    if (msg.id !== undefined && msg.method) {
      let result: any = null;
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params && msg.params.items) || [];
        result = items.map(() => ({}));
      }
      this.post({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    // Notification from the server.
    if (msg.method) this.handleNotification(msg.method, msg.params);
  }

  private handleNotification(method: string, params: any) {
    if (method === 'textDocument/publishDiagnostics') {
      this.applyDiagnostics(params);
    } else if (method === '$/progress') {
      const kind = params && params.value && params.value.kind;
      if (kind === 'begin') this.onStatus('indexing');
      else if (kind === 'end' && this.initialized) this.onStatus('ready');
    }
  }

  // --- lifecycle -----------------------------------------------------------

  private ensureInitialized(workspaceDir: string): Promise<void> {
    if (this.initOnce) return this.initOnce;
    this.onStatus('connecting');
    this.initOnce = this.connect().then(() => {
      if (this.failed) return;
      const rootUri = pathToUri(workspaceDir);
      return this.request('initialize', {
        processId: null,
        clientInfo: { name: 'dark-monaco-editor' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: {},
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            publishDiagnostics: {},
            formatting: {},
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
      }).then(
        () => {
          this.notify('initialized', {});
          this.initialized = true;
          this.onStatus('ready');
        },
        () => {
          this.failed = true;
          this.onStatus('unavailable');
        },
      );
    });
    return this.initOnce;
  }

  // setDocument makes `model` (a Go file at absolute `path`) the active LSP
  // document, initializing gopls on first use.
  async setDocument(model: any, path: string) {
    if (this.failed) return;
    await this.ensureInitialized(dirOf(path));
    if (this.failed) return;

    // Close any previously open document.
    if (this.model) {
      this.notify('textDocument/didClose', { textDocument: { uri: this.docUri } });
      this.monaco.editor.setModelMarkers(this.model, 'gopls', []);
    }
    this.detachModel();

    this.model = model;
    this.docUri = pathToUri(path);
    this.docVersion = 1;
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: this.docUri,
        languageId: 'go',
        version: this.docVersion,
        text: model.getValue(),
      },
    });

    // Sync edits to gopls (full-text, lightly debounced).
    this.changeSub = model.onDidChangeContent(() => {
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => {
        if (!this.model) return;
        this.docVersion++;
        this.notify('textDocument/didChange', {
          textDocument: { uri: this.docUri, version: this.docVersion },
          contentChanges: [{ text: this.model.getValue() }],
        });
      }, 250);
    });
  }

  // clearDocument detaches LSP from the editor (e.g. a non-Go file was opened).
  clearDocument() {
    if (this.model) {
      this.notify('textDocument/didClose', { textDocument: { uri: this.docUri } });
      this.monaco.editor.setModelMarkers(this.model, 'gopls', []);
    }
    this.detachModel();
  }

  private detachModel() {
    if (this.changeSub) {
      this.changeSub.dispose();
      this.changeSub = null;
    }
    clearTimeout(this.changeTimer);
    this.model = null;
    this.docUri = '';
  }

  // --- diagnostics ---------------------------------------------------------

  private applyDiagnostics(params: any) {
    if (!this.model || !params || params.uri !== this.docUri) return;
    const markers = (params.diagnostics || []).map((d: any) => ({
      severity: this.severity(d.severity),
      message: d.message,
      source: d.source || 'gopls',
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    }));
    this.monaco.editor.setModelMarkers(this.model, 'gopls', markers);
  }

  private severity(lsp: number): number {
    const S = this.monaco.MarkerSeverity;
    switch (lsp) {
      case 1:
        return S.Error;
      case 2:
        return S.Warning;
      case 3:
        return S.Info;
      default:
        return S.Hint;
    }
  }

  // --- monaco providers ----------------------------------------------------

  private registerProviders() {
    const m = this.monaco;

    m.languages.registerCompletionItemProvider('go', {
      triggerCharacters: ['.'],
      provideCompletionItems: async (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const fallback = new m.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        try {
          const res = await this.req(model, 'textDocument/completion', {
            textDocument: { uri: this.docUri },
            position: this.lspPos(position),
          });
          const items = Array.isArray(res) ? res : (res && res.items) || [];
          return {
            suggestions: items.map((it: any) => {
              const te = it.textEdit;
              return {
                label: it.label,
                kind: this.completionKind(it.kind),
                insertText: (te && te.newText) || it.insertText || it.label,
                insertTextRules:
                  it.insertTextFormat === 2
                    ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : undefined,
                detail: it.detail,
                documentation: this.markup(it.documentation),
                sortText: it.sortText,
                filterText: it.filterText,
                range: te && te.range ? this.monacoRange(te.range) : fallback,
              };
            }),
          };
        } catch (_) {
          return { suggestions: [] };
        }
      },
    });

    m.languages.registerHoverProvider('go', {
      provideHover: async (model: any, position: any) => {
        try {
          const res = await this.req(model, 'textDocument/hover', {
            textDocument: { uri: this.docUri },
            position: this.lspPos(position),
          });
          if (!res || !res.contents) return null;
          return { contents: [this.markup(res.contents)] };
        } catch (_) {
          return null;
        }
      },
    });

    m.languages.registerDefinitionProvider('go', {
      provideDefinition: async (model: any, position: any) => {
        try {
          const res = await this.req(model, 'textDocument/definition', {
            textDocument: { uri: this.docUri },
            position: this.lspPos(position),
          });
          const locs = Array.isArray(res) ? res : res ? [res] : [];
          return locs.map((loc: any) => ({
            // gopls returns file:// URIs; for a definition inside the open
            // file, use the model's own URI so Monaco navigates in place.
            uri: loc.uri === this.docUri ? model.uri : m.Uri.parse(loc.uri),
            range: this.monacoRange(loc.range),
          }));
        } catch (_) {
          return [];
        }
      },
    });

    m.languages.registerSignatureHelpProvider('go', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model: any, position: any) => {
        try {
          const res = await this.req(model, 'textDocument/signatureHelp', {
            textDocument: { uri: this.docUri },
            position: this.lspPos(position),
          });
          if (!res || !res.signatures) return null;
          return {
            value: {
              signatures: res.signatures.map((s: any) => ({
                label: s.label,
                documentation: this.markup(s.documentation),
                parameters: (s.parameters || []).map((p: any) => ({
                  label: p.label,
                  documentation: this.markup(p.documentation),
                })),
              })),
              activeSignature: res.activeSignature || 0,
              activeParameter: res.activeParameter || 0,
            },
            dispose: () => {},
          };
        } catch (_) {
          return null;
        }
      },
    });

    m.languages.registerDocumentFormattingEditProvider('go', {
      provideDocumentFormattingEdits: async (model: any) => {
        try {
          const res = await this.req(model, 'textDocument/formatting', {
            textDocument: { uri: this.docUri },
            options: { tabSize: 4, insertSpaces: false },
          });
          return (res || []).map((e: any) => ({
            range: this.monacoRange(e.range),
            text: e.newText,
          }));
        } catch (_) {
          return [];
        }
      },
    });
  }

  // req guards a provider call: it runs only when `model` is the active LSP
  // document and gopls has finished initializing.
  private async req(model: any, method: string, params: any): Promise<any> {
    if (this.failed || !this.model || model !== this.model) return null;
    if (this.initOnce) await this.initOnce;
    if (this.failed) return null;
    return this.request(method, params);
  }

  // --- conversions ---------------------------------------------------------

  private lspPos(p: any) {
    return { line: p.lineNumber - 1, character: p.column - 1 };
  }

  private monacoRange(r: any) {
    return new this.monaco.Range(
      r.start.line + 1,
      r.start.character + 1,
      r.end.line + 1,
      r.end.character + 1,
    );
  }

  // markup normalizes an LSP string / MarkupContent / array into a Monaco
  // IMarkdownString.
  private markup(c: any): any {
    if (c == null) return undefined;
    if (typeof c === 'string') return { value: c };
    if (Array.isArray(c)) {
      return {
        value: c.map((x) => (typeof x === 'string' ? x : x.value || '')).join('\n\n'),
      };
    }
    return { value: c.value || '' };
  }

  private completionKind(lsp: number): number {
    const K = this.monaco.languages.CompletionItemKind;
    const map: Record<number, number> = {
      1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
      6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
      11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
      16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
      21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator,
      25: K.TypeParameter,
    };
    return map[lsp] !== undefined ? map[lsp] : K.Text;
  }
}
