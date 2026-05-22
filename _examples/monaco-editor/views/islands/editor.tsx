import { useEffect, useRef, useState } from 'preact/hooks';
import { GoLSP } from './lsp.ts';
import { tokyoNight } from './tokyo-night.ts';

// Map a file extension to a Monaco language id.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', go: 'go', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml',
  py: 'python', rb: 'ruby', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
  sh: 'shell', bash: 'shell', sql: 'sql', php: 'php',
};

function langFromName(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return 'plaintext';
  return EXT_LANG[name.slice(i + 1).toLowerCase()] || 'plaintext';
}

export default function Editor({
  initialContent,
  initialFilename,
  initialLanguage,
  initialPath,
}: any) {
  const hostRef = useRef<any>(null);
  const edRef = useRef<any>(null);
  const lspRef = useRef<any>(null);

  const [filename, setFilename] = useState(initialFilename || 'untitled.txt');
  const [path, setPath] = useState(initialPath || '');
  const [language, setLanguage] = useState(initialLanguage || 'plaintext');
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState('Ln 1, Col 1');
  const [status, setStatus] = useState('Loading Monaco…');
  const [lsp, setLsp] = useState('');

  // Load Monaco via its AMD loader once, on the client.
  useEffect(() => {
    const w = window as any;
    if (!w.require) {
      setStatus('Monaco not found — run `make vendor`, then restart.');
      return;
    }
    let disposed = false;
    w.require.config({ paths: { vs: '/vs' } });
    w.require(['vs/editor/editor.main'], () => {
      if (disposed || !hostRef.current) return;
      const monaco = w.monaco;
      monaco.editor.defineTheme('tokyo-night', tokyoNight);
      const ed = monaco.editor.create(hostRef.current, {
        value: initialContent || '',
        language: initialLanguage || 'plaintext',
        theme: 'tokyo-night',
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
      });
      edRef.current = ed;
      ed.onDidChangeModelContent(() => setDirty(true));
      ed.onDidChangeCursorPosition((e: any) => {
        setCursor('Ln ' + e.position.lineNumber + ', Col ' + e.position.column);
      });
      ed.focus();
      setStatus('Ready');

      // Go language intelligence via gopls.
      lspRef.current = new GoLSP(monaco, (s: string) => setLsp('gopls: ' + s));
      if ((initialLanguage || '') === 'go' && initialPath) {
        lspRef.current.setDocument(ed.getModel(), initialPath);
      }
    });
    return () => {
      disposed = true;
      if (edRef.current) edRef.current.dispose();
    };
  }, []);

  function applyLanguage(lang: string) {
    const w = window as any;
    if (edRef.current && w.monaco) {
      w.monaco.editor.setModelLanguage(edRef.current.getModel(), lang);
    }
    setLanguage(lang);
  }

  // Attach the loaded document to gopls (Go files) or detach it (other files).
  function syncLSP(lang: string, filePath: string) {
    const client = lspRef.current;
    if (!client) return;
    if (lang === 'go' && filePath) client.setDocument(edRef.current.getModel(), filePath);
    else client.clearDocument();
  }

  // Open: native file dialog -> Go read_file binding -> load into Monaco.
  async function openFile() {
    const w = window as any;
    if (!w.dark || !w.read_file) {
      setStatus('Native bridge unavailable (desktop only).');
      return;
    }
    try {
      const picked = await w.dark.openFile({ title: 'Open file' });
      if (!picked) return;
      const file = await w.read_file(picked);
      if (edRef.current) edRef.current.setValue(file.content);
      const lang = langFromName(file.name);
      setFilename(file.name);
      setPath(file.path);
      applyLanguage(lang);
      setDirty(false);
      setStatus('Opened ' + file.path);
      syncLSP(lang, file.path);
    } catch (err: any) {
      setStatus('Open failed: ' + (err && err.message ? err.message : err));
    }
  }

  // Save: Go write_file binding, prompting for a path the first time.
  async function saveFile() {
    const w = window as any;
    if (!edRef.current) return;
    if (!w.dark || !w.write_file) {
      setStatus('Native bridge unavailable (desktop only).');
      return;
    }
    try {
      const prev = path;
      let target = prev;
      if (!target) {
        target = await w.dark.saveFile({ title: 'Save file', filename });
        if (!target) return;
      }
      await w.write_file(target, edRef.current.getValue());
      const base = target.split(/[\\/]/).pop() || filename;
      const lang = langFromName(base);
      setPath(target);
      setFilename(base);
      applyLanguage(lang);
      setDirty(false);
      setStatus('Saved ' + target);
      if (target !== prev) syncLSP(lang, target);
    } catch (err: any) {
      setStatus('Save failed: ' + (err && err.message ? err.message : err));
    }
  }

  return (
    <div class="editor-shell">
      <div class="toolbar">
        <button class="btn" onClick={openFile}>Open</button>
        <button class="btn" onClick={saveFile}>Save</button>
        <span class="filename">
          {filename}
          {dirty ? <span class="dot">●</span> : null}
        </span>
        <span class="spacer" />
        {lsp ? <span class="lsp-badge">{lsp}</span> : null}
        <span class="lang-badge">{language}</span>
      </div>
      {/* Monaco mounts into this div and owns its subtree; Preact never
          renders children here, so re-renders leave the editor intact. */}
      <div ref={hostRef} class="editor-host" />
      <div class="statusbar">
        <span>{status}</span>
        <span class="spacer" />
        <span>{cursor}</span>
      </div>
    </div>
  );
}
