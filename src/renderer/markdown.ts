import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: true });
// Images in model output must not contact an external server on render.
markdown.disable("image");
markdown.validateLink = (url) => /^https?:\/\//i.test(url);

export function renderMarkdown(root: Document, body: HTMLElement, text: string): void {
  const append = (parent: HTMLElement, tokens: ReturnType<typeof markdown.parse>) => {
    const stack = [parent];
    for (const token of tokens) {
      const current = stack[stack.length - 1]!;
      if (token.type === "inline") {
        append(current, token.children ?? []);
      } else if (token.nesting === -1) {
        stack.pop();
      } else if (token.hidden) {
        if (token.nesting === 1) stack.push(current);
      } else if (token.type === "fence" || token.type === "code_block") {
        const block = root.createElement("pre");
        const code = root.createElement("code");
        code.textContent = token.content;
        block.append(code);
        current.append(block);
      } else {
        const element = root.createElement(token.tag || "span");
        for (const [name, value] of token.attrs ?? []) element.setAttribute(name, String(value));
        element.textContent = token.type === "softbreak" ? "\n" : token.content;
        if (token.type === "link_open") element.setAttribute("rel", "noreferrer noopener");
        current.append(element);
        if (token.nesting === 1) stack.push(element);
      }
    }
  };
  append(body, markdown.parse(text, {}));
}
