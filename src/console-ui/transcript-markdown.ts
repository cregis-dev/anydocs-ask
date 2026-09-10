import { Marked, Renderer } from 'marked';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const renderer = new Renderer();
// Saved model output is untrusted. No raw HTML or remote images in transcripts.
renderer.html = ({ text }) => escape(text);
renderer.image = ({ text }) => escape(text);
renderer.link = function ({ href, tokens }) {
  const text = this.parser.parseInline(tokens);
  try {
    if (!['https:', 'http:', 'mailto:'].includes(new URL(href, 'https://console.invalid').protocol)) return text;
  } catch { return text; }
  return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};
const markdown = new Marked({ renderer, breaks: true, gfm: true });
export function renderTranscriptMarkdown(body: string): string {
  return markdown.parse(body, { async: false });
}
