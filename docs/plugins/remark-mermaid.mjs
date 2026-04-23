import { visit } from 'unist-util-visit';

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function remarkMermaid() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || !parent) return;
      parent.children[index] = {
        type: 'html',
        value: `<pre class="mermaid">${escapeHtml(node.value)}</pre>`,
      };
    });
  };
}
