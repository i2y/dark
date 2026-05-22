import { island } from 'dark';
import Editor from '../islands/editor.tsx';

const CodeEditor = island('editor', Editor);

export default function IndexPage({ content, filename, language, path }: any) {
  return (
    <CodeEditor
      initialContent={content}
      initialFilename={filename}
      initialLanguage={language}
      initialPath={path}
    />
  );
}
