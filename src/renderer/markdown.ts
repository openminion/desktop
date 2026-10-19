import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: true });
// Images in model output must not contact an external server on render.
markdown.disable("image");
markdown.validateLink = (url) => /^https?:\/\//i.test(url);

export function renderMarkdown(
  root: Document,
  body: HTMLElement,
  text: string,
  createCodeCopyButton: (code: string) => HTMLButtonElement,
): void {
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
        const container = root.createElement("div");
        container.className = "code-block";
        const header = root.createElement("div");
        header.className = "code-header";
        const language = root.createElement("span");
        language.textContent = token.info.trim().split(/\s+/)[0] || "Code";
        header.append(language, createCodeCopyButton(token.content));
        const block = root.createElement("pre");
        block.tabIndex = 0;
        block.setAttribute("aria-label", "Code block");
        const code = root.createElement("code");
        code.textContent = token.content;
        block.append(code);
        container.append(header, block);
        current.append(container);
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
