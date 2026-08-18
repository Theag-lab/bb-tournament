import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/**
 * Renders markdown to an HTML string. The result is bound via [innerHTML] without bypassing
 * Angular's sanitizer, so unsafe tags/attributes (script, event handlers, javascript: URLs) are
 * stripped automatically — safe to use with admin-authored, not fully trusted, content.
 */
export function renderMarkdown(source: string): string {
  if (!source || !source.trim()) return '';
  return marked.parse(source, { async: false }) as string;
}
