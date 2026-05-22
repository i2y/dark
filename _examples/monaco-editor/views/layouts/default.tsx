export default function Layout({ children, _head }: any) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{_head?.title || 'Dark Code Editor'}</title>
        {/* Monaco AMD loader — defines window.require before island modules run */}
        <script src="/vs/loader.js"></script>
        <style>{`
          /* Chrome colors follow the Tokyo Night palette (see tokyo-night.ts
             for the matching Monaco editor theme). */
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { height: 100%; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #1a1b26;
            color: #a9b1d6;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          main, dark-island, .editor-shell {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
          }
          .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: #16161e;
            border-bottom: 1px solid #15161e;
            flex: 0 0 auto;
          }
          .btn {
            background: #3d59a1;
            color: #c0caf5;
            border: none;
            border-radius: 3px;
            padding: 4px 12px;
            font-size: 12px;
            cursor: pointer;
          }
          .btn:hover { background: #7aa2f7; color: #1a1b26; }
          .btn:active { background: #2e4272; color: #c0caf5; }
          .filename { font-size: 12px; color: #a9b1d6; margin-left: 4px; }
          .filename .dot { color: #e0af68; font-weight: 700; margin-left: 5px; }
          .spacer { flex: 1; }
          .lsp-badge {
            font-size: 11px;
            color: #9ece6a;
          }
          .lang-badge {
            font-size: 11px;
            color: #565f89;
            text-transform: uppercase;
            letter-spacing: 0.06em;
          }
          .editor-host { flex: 1; min-height: 0; }
          .statusbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 3px 12px;
            background: #16161e;
            color: #7aa2f7;
            font-size: 11px;
            flex: 0 0 auto;
          }
        `}</style>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
