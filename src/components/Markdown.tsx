import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Safe markdown rendering (no raw HTML; react-markdown drops javascript: URLs). */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
