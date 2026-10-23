"""Lossless capsula/1 ↔ plantilla_guion_v5 adapter. Times are output seconds."""
import copy
import math

FIELDS = ('gancho', 'giro', 'remate')


def interval(value, name='tiempo'):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError(f'{name}: se requieren inicio y fin')
    a, b = map(float, value)
    if not all(math.isfinite(x) for x in (a, b)) or a < 0 or b <= a or b > 180:
        raise ValueError(f'{name}: intervalo inválido')
    return [a, b]


def validate(document):
    if document.get('schema') != 'capsula/1':
        raise ValueError('schema debe ser capsula/1')
    texts = document.get('textos') or {}
    times = document.get('tiempos') or {}
    previous = 2 if (document.get('cartelas') or {}).get('preroll') else 0
    for field in FIELDS:
        if not isinstance(texts.get(field), str) or not texts[field].strip() or len(texts[field]) > 600:
            raise ValueError(f'textos.{field}: texto requerido (máximo 600 caracteres)')
        a, b = interval(times.get(field), f'tiempos.{field}')
        if abs(a - previous) > 0.011:
            raise ValueError('los tiempos deben ser contiguos y no solaparse')
        previous = b
    for span in document.get('spans') or []:
        text = texts.get(span.get('campo'), '')
        if not isinstance(text, str) or span.get('estilo') not in ('normal', 'cifra', 'enfasis'):
            raise ValueError('estilo o campo de span inválido')
        if not (isinstance(span.get('ini'), int) and isinstance(span.get('fin'), int)
                and 0 <= span['ini'] < span['fin'] <= len(text)):
            raise ValueError('rango de span inválido')
    for item in document.get('media') or []:
        if item.get('tipo') not in ('image', 'video') or not item.get('src'):
            raise ValueError('media necesita tipo y src')
        _, media_end = interval(item.get('t'), 'media.t')
        if media_end > previous:
            raise ValueError('media.t supera el cuerpo de la cápsula')
        if not str(item.get('credito') or '').strip():
            raise ValueError('media necesita crédito')
        crop = item.get('recorte')
        if crop:
            x, y = float(crop.get('x', 0)), float(crop.get('y', 0))
            w, h = float(crop.get('w', crop.get('width', 1))), float(crop.get('h', crop.get('height', 1)))
            if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.001 or y+h > 1.001:
                raise ValueError('recorte fuera de la imagen')
    return document


def from_guion(guion, parent_id=None, version=1):
    """Keep the original guion, including unknown fields, for future revisions."""
    g = copy.deepcopy(guion)
    c = g['capsulas'][0]
    cart = c.get('cartelas') or {'preroll': True, 'postroll': True}
    off = 0 if cart.get('preroll') else 2
    # The editable beats include the template's fades. linea_t has intentional
    # animation gaps and cannot be used as the contiguous authoring timeline.
    times = {k: [round(max(0, float(t)-off), 4) for t in c[k].get('t', c[k]['linea_t'])] for k in FIELDS}
    # An initial fade-in is template animation, not an editable pause before the first line.
    times['gancho'][0] = 2 if cart.get('preroll') else 0
    br = c['giro'].get('broll') or {}
    origin = g.get('origen') or {}
    duration = max(v[1] for v in times.values())
    return {'schema': 'capsula/1', 'ref': origin.get('encargo'), 'version': int(version),
            'parentId': parent_id, 'plantilla': 'v5.7',
            'orientaciones': ['vertical', 'horizontal'], 'saga': copy.deepcopy(g.get('saga') or {}),
            'origen': copy.deepcopy(origin), 'sourceGuion': g,
            'textos': {'titulo': (c.get('preroll') or {}).get('subtitulo') or g.get('objeto') or c.get('titulo', '¿Sabías que?'),
                       'tipologia': (c.get('preroll') or {}).get('tipologia', ''),
                       'subtitulo': (c.get('preroll') or {}).get('subtitulo') or g.get('objeto', ''),
                       **{k: c[k]['linea'] for k in FIELDS},
                       'fuente': copy.deepcopy(c['remate'].get('fuente') or {})},
            'spans': [], 'media': [], 'tiempos': times, 'cartelas': copy.deepcopy(cart),
            'sourceMedia': {'src': 'fuente.mp4', 'sourceUrl': origin.get('url'),
                            'credito': br.get('credito', ''), 't': [0, duration]},
            'nextVersion': int(version)+1}


def to_guion(document, fallback=None):
    validate(document)
    g = copy.deepcopy(document.get('sourceGuion') or fallback)
    if not g or not g.get('capsulas'):
        raise ValueError('sourceGuion o guion base requerido')
    c = g['capsulas'][0]
    texts = document['textos']
    cart = copy.deepcopy(document.get('cartelas') or {'preroll': False, 'postroll': False})
    off = 0 if cart.get('preroll') else 2
    end = max(interval(document['tiempos'][k])[1] for k in FIELDS)
    duration = end + (4 if cart.get('postroll') else 0)
    c['cartelas'] = cart
    c['duracion_s'] = duration
    c['plantilla'] = 'v5.7'
    c['version'] = f"v{int(document.get('version') or 1)}"
    # «¿Sabías que?» is the template brand. The editor's Titular is the real
    # headline, shared by the composition and the definitive renderer.
    c['titulo'] = '¿Sabías que?'
    c.setdefault('preroll', {}).update({'titulo': c['titulo'], 'tipologia': texts.get('tipologia', ''),
                                      'subtitulo': texts.get('titulo') or texts.get('subtitulo', '')})
    for field in FIELDS:
        c.setdefault(field, {}).update({'linea': texts[field],
            'linea_t': [t+off for t in interval(document['tiempos'][field])],
            't': [t+off for t in interval(document['tiempos'][field])]})
    source = texts.get('fuente') or {}
    if isinstance(source, str):
        source = {'texto': source, 'url': (g.get('origen') or {}).get('url', '')}
    start = interval(document['tiempos']['gancho'])[0]
    c['remate']['fuente'] = {**c['remate'].get('fuente', {}), **source, 't': [start, end]}
    c.setdefault('giro', {}).setdefault('broll', {})['t_capsula'] = [start, end]
    c['postroll'] = {**c.get('postroll', {}), 't': [end, duration]}
    c.setdefault('barra_progreso', {})['t'] = [0, duration]
    c.setdefault('audio', {})['t'] = [0, duration]
    g['saga'] = copy.deepcopy(document.get('saga') or g.get('saga') or {})
    g['locucion'] = {'gancho': texts['gancho'], 'cifra': texts['giro'], 'idea': texts['remate']}
    g['fuente'] = source.get('texto', '')
    g['capsulaEditor'] = {'spans': copy.deepcopy(document.get('spans') or []),
                          'media': copy.deepcopy(document.get('media') or []),
                          'sourceMedia': copy.deepcopy(document.get('sourceMedia') or {}),
                          'ref': document.get('ref'), 'parentId': document.get('parentId')}
    return g
