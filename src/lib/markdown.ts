// One Markdown renderer for the whole site: the page files and the YAML block
// bodies. Smart punctuation matches what kramdown (Jekyll) produced.
import { Marked } from "marked";
import { smartypantsu } from "smartypants";

const marked = new Marked({ gfm: true, async: false });

/** Lowercase, drop punctuation, spaces to hyphens: kramdown's auto heading ids. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(text)}">${text}</h${depth}>\n`;
    },
  },
});

/**
 * marked escapes quotes in text as &#39; / &quot;, which hides them from SmartyPants.
 * Turn them back into characters in text only (never inside a tag), so SmartyPants can
 * curl them. Text outside tags can't break markup with a bare quote.
 */
function unescapeQuotesInText(html: string): string {
  return html.replace(/(^|>)([^<]*)/g, (_m, gt: string, text: string) =>
    gt + text.replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
}

/** Markdown to HTML, with straight quotes and dashes made typographic. */
export function markdownify(src: string | undefined | null): string {
  if (!src) return "";
  // smartypants mode "2": quotes, backticks, "--" en dash and "---" em dash, as kramdown did.
  // It skips the contents of <code>, <pre> and tags.
  return smartypantsu(unescapeQuotesInText(marked.parse(src) as string), "2");
}

/** Smart quotes for plain text (titles and descriptions in <head>). */
export function smartify(text: string | undefined | null): string {
  return text ? smartypantsu(text, "2") : "";
}
