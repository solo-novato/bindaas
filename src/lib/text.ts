export function editorText(text: string) {
  return text.replace(/\r\n/g, '\n');
}
export function diskText(text: string, newline: string) {
  return newline === 'crlf' ? editorText(text).replace(/\n/g, '\r\n') : text;
}
