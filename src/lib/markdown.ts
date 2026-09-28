import MarkdownIt from 'markdown-it';
const renderer = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});
// Images can trigger external requests; v1 shows their alt text instead.
renderer.renderer.rules.image = (tokens, index) =>
  renderer.utils.escapeHtml(`[Image: ${tokens[index].content}]`);
const defaultFence = renderer.renderer.rules.fence!;
renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
  const language = renderer.utils.escapeHtml(
    tokens[index].info.trim().split(/\s+/)[0] || 'Code',
  );
  return `<div class="code-block"><div class="code-toolbar"><span>${language}</span><button type="button" data-copy-code>Copy code</button></div>${defaultFence(tokens, index, options, env, self)}</div>`;
};
export function markdown(text: string) {
  return renderer.render(text);
}
export function linkTarget(
  href: string,
  source: string,
  projectRoot?: string,
): { external?: string; path?: string; anchor?: string } {
  if (href.startsWith('#')) return { anchor: href.slice(1) };
  if (/^https?:\/\//i.test(href)) {
    const url = new URL(href);
    if (url.username || url.password) throw Error('Link contains credentials');
    return { external: url.href };
  }
  let decoded = decodeURIComponent(href.split('#')[0]);
  if (projectRoot && decoded.startsWith(`${projectRoot}/`))
    decoded = decoded.slice(projectRoot.length + 1);
  if (/^[a-z][a-z\d+.-]*:|^\/|^\\/i.test(decoded))
    throw Error('Unsupported link');
  decoded = decoded.replace(/:\d+(?::\d+)?$/, '');
  if (decoded.includes('\\')) throw Error('Unsupported path');
  const parts = source.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (!parts.length) throw Error('Link leaves project');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return { path: parts.join('/') };
}
