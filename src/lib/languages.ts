export async function language(path: string) {
  const ext = path.split('.').at(-1)?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: ext === 'ts' || ext === 'tsx',
        jsx: ext === 'jsx' || ext === 'tsx',
      });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
    case 'svelte':
      return (await import('@codemirror/lang-html')).html();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'yml':
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'xml':
    case 'svg':
      return (await import('@codemirror/lang-xml')).xml();
    default:
      return [];
  }
}
