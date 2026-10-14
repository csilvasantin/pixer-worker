import { canonTag, hashtagsIn, STOCK_TAGS_MAX } from './stock-catalogo.mjs';
import { parsePoster } from './stock-poster.mjs';
export const SEARCH_TAGS_MAX = 24;

// Search evidence is never a broadcast address. Only deliberate operator tags route imports.
export function searchContext(value) {
  if (!value || value.version !== 1) return null;
  return { version: 1, description: typeof value.description === 'string' ? value.description.trim().slice(0, 4000) : '' };
}
export function importRoutingSource(comment, manual) {
  return {tags:unique(Array.isArray(manual) ? manual : []),comment:typeof comment==='string' ? comment.slice(0,2000) : ''};
}
export function unique(values, limit = STOCK_TAGS_MAX) {
  return [...new Set(values.map(canonTag).filter(Boolean))].slice(0, limit);
}
export function textSearchTags(...texts) {
  const text = texts.filter(v => typeof v === 'string').join(' ').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/\S+/g, ' ').replace(/\b\d{2,5}\s*[x×]\s*\d{2,5}\b/g, ' ');
  const tags = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)].map(m => m[0]);
  const music = /\b(?:music|musica|songs?|canciones?|cancion|musical)\b/.test(text);
  if (music) tags.push('música');
  if (/\b(?:songs?|canciones?|cancion)\b/.test(text)) tags.push('canción');
  if (music && /\b(?:top|best|mejores|exitos|hits)\b/.test(text)) tags.push('top canciones');
  if (music && tags.some(t => /^198\d$/.test(t))) tags.push('años 80');
  if (music && tags.some(t => /^199\d$/.test(t))) tags.push('años 90');
  return unique(tags);
}
export function inferredSearchTags({ manual = [], comment = '', title = '', description = '', generated = [] }) {
  return unique([...hashtagsIn(comment), ...manual, ...textSearchTags(comment, title, description),
    ...generated, ...hashtagsIn(title, description)], SEARCH_TAGS_MAX);
}
export function visualSamples(values) {
  return (Array.isArray(values) ? values : []).slice(0, 3).flatMap(value => {
    if (typeof value !== 'string' || value.length > 280000) return [];
    const parsed = parsePoster(value);
    if (parsed.error) return [];
    return [{ inlineData: { mimeType: parsed.mime, data: value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') } }];
  });
}
export function taggingEvidence(context, info, auto) {
  return { version: 1, sources: [info.comment ? 'comments' : '', info.title ? 'title' : '',
    context.description ? 'description' : '', auto.visualFrames ? 'video-frames' : ''].filter(Boolean),
    visualFrames: auto.visualFrames || 0, model: auto.model || null,
    generatedTags: Array.isArray(auto.tags) ? auto.tags.slice(0,8) : [],
    status: auto.model ? 'classified' : 'text-fallback' };
}
