#!/usr/bin/env python3
"""stock-posters.py — pósters para el Stock de Pixeria (FLT pixeria stock, 4-sep-2026).

Lee el índice público del Stock, busca los vídeos/animaciones sin miniatura y las
imágenes sin miniatura, saca un fotograma real con ffmpeg (al segundo 1,2 o al 12 %
de la duración: el frame 0 suele ser negro por el fundido de entrada), lo reduce a
480 px de ancho y lo sube al worker (POST /stock/poster), que lo guarda en R2 y lo
deja de `thumbnail`. Un Worker no puede decodificar vídeo: por eso corre aquí, en el
Mac Mini, cada 10 min por launchd (com.csilvasantin.stock-posters). Así el póster
llega a los pocos minutos de publicar, sin tocar ninguna página de publicación.

Clave: ~/.fleet/stock-poster.key (secreto STOCK_POSTER_KEY del worker pixer-eleven).
Fallos: ~/.fleet/stock-posters-failed.json (id → intentos); a los 3 se deja en paz.
Uso: stock-posters.py [--limit N] [--dry-run] [--id ID]
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.request

INDEX = 'https://stock.admira.store/stock/index.json'
API = 'https://api.admira.store/stock/poster'
KEY_FILE = os.path.expanduser('~/.fleet/stock-poster.key')
FAIL_FILE = os.path.expanduser('~/.fleet/stock-posters-failed.json')
MEDIA_VIDEO = {'video', 'animation'}
MEDIA_IMAGE = {'image', 'digital-twin'}
WIDTH = 480

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def leer_json(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'stock-posters/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def duracion(url):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
                             capture_output=True, text=True, timeout=40).stdout.strip()
        return float(out) if out and out != 'N/A' else 0.0
    except Exception:
        return 0.0

def fotograma(url, es_video, destino):
    """Devuelve el instante usado (o None si es imagen). Lanza si ffmpeg falla."""
    t = None
    cmd = ['ffmpeg', '-v', 'error', '-y']
    if es_video:
        d = duracion(url)
        t = round(min(1.2, d * 0.12), 2) if d > 0 else 1.0
        cmd += ['-ss', str(t)]
    cmd += ['-i', url, '-frames:v', '1', '-vf', f"scale='min({WIDTH},iw)':-2", '-q:v', '4', '-f', 'image2', destino]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    if os.path.getsize(destino) < 200:
        raise RuntimeError('fotograma vacío')
    return t

def subir(key, item_id, ruta, t):
    b64 = base64.b64encode(open(ruta, 'rb').read()).decode()
    body = json.dumps({'secret': key, 'id': item_id, 'base64': b64, 'mime': 'image/jpeg', 'at': t}).encode()
    req = urllib.request.Request(API, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'stock-posters/1.0'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def candidatos(items):
    for it in items:
        t = it.get('type'); th = it.get('thumbnail') or ''; url = it.get('url') or ''
        if not url or not it.get('id'):
            continue
        if t in MEDIA_VIDEO and not th:
            yield it, True
        elif t in MEDIA_IMAGE and not th and (it.get('size') or 0) > 60 * 1024:
            yield it, False

def main():
    args = sys.argv[1:]
    limit = int(args[args.index('--limit') + 1]) if '--limit' in args else 40
    dry = '--dry-run' in args
    solo = args[args.index('--id') + 1] if '--id' in args else None
    key = open(KEY_FILE).read().strip() if os.path.exists(KEY_FILE) else ''
    if not key and not dry:
        log('✖ falta', KEY_FILE); return 2
    try:
        fails = json.load(open(FAIL_FILE))
    except Exception:
        fails = {}
    items = leer_json(INDEX).get('items') or []
    pend = [(it, v) for it, v in candidatos(items) if (not solo or it['id'] == solo) and fails.get(it['id'], 0) < 3]
    log(f'índice: {len(items)} assets · sin póster: {len(pend)} · esta pasada: {min(limit, len(pend))}')
    hechos = 0
    with tempfile.TemporaryDirectory() as tmp:
        for it, es_video in pend[:limit]:
            iid = it['id']; dest = os.path.join(tmp, iid + '.jpg')
            try:
                t = fotograma(it['url'], es_video, dest)
                if dry:
                    log('·', iid, it.get('type'), f'{os.path.getsize(dest)//1024} KB', f't={t}'); continue
                r = subir(key, iid, dest, t)
                if not r.get('ok'):
                    raise RuntimeError(json.dumps(r))
                hechos += 1
                log('✓', iid, it.get('type'), f'{r.get("size", 0)//1024} KB', f't={t}')
                fails.pop(iid, None)
            except subprocess.CalledProcessError as e:
                err = (e.stderr or b'').decode(errors='replace').strip().splitlines()[-1:] or ['']
                # Un timeout o un corte de red no es culpa del asset: no consume intentos.
                # (4-sep-2026: LaLiga bloqueó r2.dev a media pasada y 86 assets quedaron
                # marcados como fallidos sin serlo.)
                red = any(k in err[0] for k in ('timed out', 'Connection', 'Server returned 5', 'Input/output error', 'Network'))
                if not red: fails[iid] = fails.get(iid, 0) + 1
                log('✖' if not red else '⏳', iid, 'ffmpeg:', err[0][:120], '' if not red else '(red, se reintenta)')
                if red: time.sleep(2)
            except Exception as e:
                fails[iid] = fails.get(iid, 0) + 1
                log('✖', iid, type(e).__name__, str(e)[:160])
    if not dry:
        os.makedirs(os.path.dirname(FAIL_FILE), exist_ok=True)
        json.dump(fails, open(FAIL_FILE, 'w'))
    log(f'hechos: {hechos} · fallos acumulados: {len(fails)}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
