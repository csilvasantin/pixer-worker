"""Template-constrained text wrapping with offsets preserved for rich spans."""
import re

def wrap_offsets(draw, text, font, width):
    lines, current, start, previous_end = [], '', 0, 0
    for match in re.finditer(r'\S+', text):
        word = match.group()
        separator = text[previous_end:match.start()]
        candidate = current+separator+word if current else word
        if current and ('\n' in separator or draw.textlength(candidate, font=font) > width):
            lines.append((current.rstrip(), start))
            current = ''
        if not current:
            start = match.start()
        else:
            current += separator
        # Split overlong words instead of overflowing the video edge.
        for index, char in enumerate(word):
            candidate = current+char
            if current and draw.textlength(candidate, font=font) > width:
                lines.append((current.rstrip(), start))
                start = match.start()+index
                current = char
            else:
                current = candidate
        previous_end = match.end()
    if current.strip():
        lines.append((current.rstrip(), start))
    return lines or [('', 0)]

def fit_text(draw, text, make_font, size, width, maxlines, minsize=12):
    for candidate in range(max(minsize, int(size)), minsize-1, -1):
        font = make_font(candidate)
        lines = wrap_offsets(draw, text, font, width)
        if len(lines) <= maxlines:
            return font, lines, candidate
    # Rendering must fail visibly rather than silently omit user text.
    raise ValueError('Texto demasiado largo para el espacio de la plantilla')

def draw_spans(draw, xy, text, offset, font, color, alpha, spans, accent):
    x, y = xy
    runs = []
    for index, char in enumerate(text):
        style = 'normal'
        for span in spans:
            if span['ini'] <= offset+index < span['fin']:
                style = span['estilo']
        if runs and runs[-1][0] == style:
            runs[-1][1] += char
        else:
            runs.append([style, char])
    for style, run in runs:
        ink = accent if style in ('cifra', 'enfasis') else color
        draw.text((x, y), run, font=font, fill=tuple(ink)+(int(255*alpha),))
        x += draw.textlength(run, font=font)
