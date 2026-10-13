import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** HTML comments are hidden, as on GitHub (notes keep table column widths in one). */
function remarkDropComments() {
  const isComment = (n: MdNode) => n.type === 'html' && /^\s*<!--[\s\S]*-->\s*$/.test(n.value ?? '');
  const walk = (n: MdNode) => {
    if (!n.children) return;
    n.children = n.children.filter((c) => !isComment(c));
    n.children.forEach(walk);
  };
  return walk;
}

/** Safe markdown rendering (no raw HTML; react-markdown drops javascript: URLs). */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDropComments]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
