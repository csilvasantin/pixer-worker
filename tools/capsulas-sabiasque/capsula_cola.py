#!/usr/bin/env python3
"""Cola «Crear cápsula desde URL» del Creador de admira.studio → render v5 en GrokBotBox → Stock.
    python3 capsula_cola.py            # ensayo: lista la cola y renderiza, NO publica
    python3 capsula_cola.py --publicar # renderiza y publica (vertical + horizontal)
    python3 capsula_cola.py --ref capsula-url:<hash> [--publicar]
El Creador encola con POST api.admira.store/capsula/url/encargar (guion ya revisado por Carlos).
Aquí se reutiliza el pipeline de las cápsulas actuales: plantilla_v5.py + render (render_url.py,
generalización de tecnologia-taalas/v2/render_v2.py) + payload() de publicar_sabias_v5.py.
Dedup: externalRef = ref del encargo; se consulta el índice del Stock por orientación antes de publicar,
y el worker solo deja un encargo por origen. B-roll: vídeo de la fuente con yt-dlp (4 s del centro) o,
si no es vídeo, su miniatura con zoom lento."""
import glob, json, os, shutil, subprocess, sys, urllib.request, datetime, hashlib, base64
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import publicar_sabias_v5 as pub
from capsula_document import to_guion
API = os.environ.get('STOCK_API', 'https://api.admira.store')
UA = {'user-agent': 'Mozilla/5.0 admiranext-capsulas', 'origin': 'https://www.admira.studio'}
PLANT = next(p for p in (os.path.join(BASE, 'tecnologia-taalas', 'v2'), BASE) if os.path.exists(os.path.join(p, 'logo.png')))
COLORES = {'tecnología': '#1F6FEB'}
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return json.load(r)
def guion_v5(job):
    if job.get('capsula'):
        return to_guion(job['capsula'])
    g = job['guion']; s = job['source']; tema = g.get('tema') or 'tecnología'
    hoy = datetime.date.today().isoformat(); slug = job['ref'].split(':')[1]
    cifra = g.get('cifra') or {}
    cart = {'preroll': bool((job.get('cartelas') or {}).get('preroll')), 'postroll': bool((job.get('cartelas') or {}).get('postroll'))}  # v5.7: apagadas por defecto
    pre = 2 if cart['preroll'] else 0; tot = pre + 12 + (4 if cart['postroll'] else 0)
    credito = 'Vídeo: ' + (s.get('author') or {'linkedin': 'LinkedIn', 'youtube': 'YouTube', 'tiktok': 'TikTok', 'x': 'X'}.get(s.get('kind'), s.get('kind') or 'fuente'))
    return {"fecha": hoy, "plantilla": "plantilla_guion_v5", "saga": {"tema": tema, "color": COLORES.get(tema, '#1F6FEB')},
        "tipo": f"url-{slug}", "objeto": g['objeto'], "fuente": g['fuente'],
        "origen": {"url": s['url'], "resuelta": s.get('resolvedUrl'), "clave": s.get('sourceKey'), "tipo": s.get('kind'), "encargo": job['ref']},
        "locucion": {"gancho": g['gancho'], "cifra": g['giro'], "idea": g['remate']},
        "idea_clave": g.get('idea', ''),
        "capsulas": [{"id": f"url-{slug}-01", "version": "v1", "duracion_s": tot, "plantilla": "v5.7", "cartelas": cart, "formatos": ["1920x1080", "1080x1920"], "titulo": "¿Sabías que?",
            "preroll": {"t": [0, 2], "logo": "admira_oficial", "titulo": "¿Sabías que?", "tipologia": tema.capitalize(), "texto": f"¿Sabías que? {tema.capitalize()}", "subtitulo": g.get('subtitulo') or ''},
            "gancho": {"t": [2, 5.05], "linea_t": [2.65, 4.95], "linea": g['gancho'],
                       "cifra": ({"desde": 0, "hasta": cifra['hasta'], "unidad": cifra.get('unidad', ''), "easing": "easeOutExpo"} if cifra.get('hasta') else None)},
            "giro": {"t": [5.05, 10.73], "linea_t": [5.05, 10.73], "linea": g['giro'], "broll": {"fichero": "broll/", "t_capsula": [pre, pre + 12], "credito": credito}},
            "remate": {"t": [10.73, 14], "linea_t": [10.95, 14], "linea": g['remate'], "fuente": {"texto": g['fuente'], "url": s['url'], "t": [2.65, 14]}},
            "barra_progreso": {"t": [0, 18], "posicion": "arriba y abajo (espejo)", "lectura": None},
            "audio": {"tipo": "silencio", "t": [0, 15]}, "postroll": {"t": [14, 18], "logo": "admira_oficial", "claim": "Connecting things to Internet", "fijo": True},
            "tags": job.get('tags') or ['capsula', 'sabiasque']}]}
# v5.2 (22-oct-2026): los Shorts de YouTube devolvían 429 + «Sign in to confirm you're not a bot» con el cliente
# web por defecto y la cápsula caía en la miniatura sin avisar. Ahora se prueban varios clientes de yt-dlp
# (android_vr funciona sin cookies para Shorts), cada intento queda en el log y, si todo falla, se anota
# «FALLBACK miniatura» y broll/origen.json lo dice. Sin cookies ni credenciales.
YTDLP_CLIENTES = (None, 'android_vr', 'tv', 'ios', 'web_safari', 'mweb', 'web_embedded')
def bajar_video(url, mp4):
    for cli in YTDLP_CLIENTES:
        cmd = ['yt-dlp', '-q', '--no-warnings', '--no-playlist', '-f', 'bv*[ext=mp4][height<=1080]+ba/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4', '-o', mp4]
        if cli: cmd += ['--extractor-args', f'youtube:player_client={cli}']
        r = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=600)
        if r.returncode == 0 and os.path.exists(mp4) and os.path.getsize(mp4) > 50000:
            print(f'  b-roll: vídeo descargado con yt-dlp (cliente {cli or "por defecto"})'); return cli or 'por defecto'
        err = (r.stderr or r.stdout or '').strip().splitlines()
        print(f'  b-roll: yt-dlp cliente {cli or "por defecto"} falló: {(err[-1] if err else "sin salida")[:200]}')
        if os.path.exists(mp4): os.remove(mp4)
    return None
def miniatura(job, out):
    """Foto de la fuente para la cartela inicial (v5.2) y como b-roll de reserva."""
    img = os.path.join(out, 'fuente.jpg'); s = job['source']
    if os.path.exists(img) and os.path.getsize(img) > 1000: return img
    try:
        if s.get('image'): urllib.request.urlretrieve(s['image'], img); return img
    except Exception as e: print('  miniatura (og:image) no disponible:', e)
    if s.get('kind') in ('youtube', 'tiktok', 'x', 'vimeo', 'instagram', 'linkedin'):
        r = subprocess.run(['yt-dlp', '-q', '--no-warnings', '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', '--extractor-args', 'youtube:player_client=android_vr', '-o', os.path.join(out, 'fuente'), s['url']], capture_output=True, text=True, timeout=120)
        if os.path.exists(img): return img
        print('  miniatura (yt-dlp) no disponible:', (r.stderr or '').strip()[-200:])
    return None
def broll(job, out):
    d = os.path.join(out, 'broll'); os.makedirs(d, exist_ok=True)
    img = miniatura(job, out)
    if any(f.startswith('f') for f in os.listdir(d)): return
    s = job['source']; origen = {'tipo': 'ninguno'}
    if s.get('kind') in ('linkedin', 'youtube', 'tiktok', 'x', 'vimeo', 'instagram'):
        mp4 = os.path.join(out, 'fuente.mp4')
        try:
            if not os.path.exists(mp4):
                # v5.3: reutiliza el vídeo ya bajado en una versión anterior del mismo encargo (YouTube corta a ratos).
                base = os.path.basename(out).split('-v')[0]; raiz = os.path.dirname(out)
                prev = sorted(glob.glob(os.path.join(raiz, base + '*', 'fuente.mp4')), key=os.path.getmtime, reverse=True)
                prev = [x for x in prev if os.path.getsize(x) > 50000 and os.path.dirname(x) != out]
                if prev: shutil.copy(prev[0], mp4); print(f'  b-roll: reutilizo el vídeo de la fuente ya descargado ({os.path.relpath(prev[0], raiz)})')
            cli = 'previo' if os.path.exists(mp4) else bajar_video(s['url'], mp4)
            if cli:
                dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], text=True).strip() or 8)
                LARGO = 12.0  # v5.3: toda la explicación (2 s → 14 s); si la fuente es más corta, render_url.py la repite en bucle
                t0 = 0.0 if dur <= LARGO + 1 else max(0, min(dur / 2 - LARGO / 2, dur - LARGO))
                # Bandas negras incrustadas (Shorts que son vídeo horizontal con barras): se recortan con cropdetect.
                cd = subprocess.run(['ffmpeg', '-v', 'info', '-ss', f'{t0:.2f}', '-t', f'{min(LARGO, dur):g}', '-i', mp4, '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'], capture_output=True, text=True).stderr
                crops = [l.split('crop=')[-1].strip() for l in cd.splitlines() if 'crop=' in l]
                crop = max(set(crops), key=crops.count) if crops else ''
                vf = (f'crop={crop},' if crop else '') + 'scale=1080:-2,fps=25'
                if crop: print(f'  b-roll: recorte de bandas {crop}')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.2f}', '-t', f'{LARGO:g}', '-i', mp4, '-vf', vf, os.path.join(d, 'f%03d.png')], check=True)
                n = len([f for f in os.listdir(d) if f.startswith('f')])
                origen = {'tipo': 'video', 'cliente': cli, 'desde_s': round(t0, 2), 'duracion_fuente_s': round(dur, 2), 'fotogramas': n, 'recorte': crop, 'bucle': dur < LARGO}
                print(f'  b-roll: VÍDEO de la fuente, {n} fotogramas desde {t0:.2f}s (de {dur:.1f}s)')
                json.dump(origen, open(os.path.join(d, 'origen.json'), 'w'), ensure_ascii=False); return
        except Exception as e: print('  b-roll vídeo no disponible:', e)
    if img:
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', img, '-vf', 'scale=1080:-2', os.path.join(d, 'f001.png')], check=True)
            origen = {'tipo': 'miniatura'}; print('  b-roll: FALLBACK miniatura con zoom lento (no se pudo obtener el vídeo)')
        except Exception as e: print('  miniatura no disponible:', e)
    json.dump(origen, open(os.path.join(d, 'origen.json'), 'w'), ensure_ascii=False)
def poster(png):
    import base64, io
    from PIL import Image
    im = Image.open(png).convert('RGB'); im.thumbnail((720, 720)); b = io.BytesIO(); im.save(b, 'JPEG', quality=82)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
def publicar(job, out, real):
    # A preview is never publishable, even when the unattended consumer uses --publicar.
    if job.get('previewOnly'):
        print('  PREVIEW: publicación y sustitución de versiones desactivadas')
        return {}
    g = json.load(open(os.path.join(out, 'guion.json'), encoding='utf-8')); ref = job['ref']
    hp = os.path.join(out, 'publicados.json'); hechos = json.load(open(hp)) if os.path.exists(hp) else {}
    ver = job.get('capsuleVersion') or 1
    ya = [x for x in get(pub.INDICE)['items'] if x.get('type') == 'video' and x.get('externalRef') == ref and ((x.get('capsuleSource') or {}).get('version') or 1) >= ver]
    for orient, nombre in (('vertical', 'capsula-9x16.mp4'), ('horizontal', 'capsula-16x9.mp4')):
        prev = [x for x in ya if orient in (x.get('tags') or [])]
        if prev or (orient in hechos and hechos[orient].get('version', 1) >= ver): print(f'  {orient}: ya en el Stock → {(hechos.get(orient) or prev[0])["id"]}'); continue
        p = pub.payload(g, os.path.join(out, nombre), orient, ref)
        p['prompt'] = (f"{g['locucion']['gancho']} · {g['locucion']['cifra']} · {g['locucion']['idea']} · Fuente: {job['source']['url']}")[:1000]
        br = g['capsulas'][0]['giro']['broll']
        p['capsuleSource'] = {'sourceUrl': job['source']['url'], 'credit': br.get('credito', ''), 'broll': {'start': br['t_capsula'][0], 'end': br['t_capsula'][1]}, 'version': job.get('capsuleVersion') or 1, **(g['capsulas'][0].get('cartelas') or {})}
        if job.get('capsula'):
            p['capsula'] = {**job['capsula'], 'version': ver}
            p['parentId'] = job['capsula'].get('parentId')
        p['poster'] = poster(os.path.join(out, nombre.replace('.mp4', '-t5s.png')))
        if not real: print(f'  [ensayo] {orient}:', json.dumps({k: v for k, v in p.items() if k != 'base64'}, ensure_ascii=False)); continue
        req = urllib.request.Request(f"{pub.API}/stock/publish", data=json.dumps(p).encode(), method='POST',
              headers={'content-type': 'application/json', 'origin': 'https://www.pixeria.com', **pub.UA})
        with urllib.request.urlopen(req, timeout=300) as r: d = json.load(r)
        if not d.get('ok'): sys.exit(f'{orient}: rechazado: {d}')
        hechos[orient] = {'id': d['id'], 'url': d['url'], 'num': d.get('num'), 'version': ver, 'superseded': d.get('superseded'), 'resp': d}
        json.dump(hechos, open(hp, 'w'), indent=1, ensure_ascii=False); print(f"  {orient}: publicado → #{d.get('num')} {d['id']} · sustituye {d.get('superseded')}")
def post(path, payload):
    headers = {'content-type': 'application/json', **UA}
    token = os.environ.get('CAPSULA_QUEUE_KEY') or os.environ.get('ADMIRA_FLEET_KEY') or os.environ.get('STOCK_ADMIN_KEY')
    if token:
        headers['X-Fleet-Key'] = token
    req = urllib.request.Request(API+path, data=json.dumps(payload).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)

def preview_result(job, out, upload=False):
    result = {'ref': job['ref'], 'capsuleVersion': job.get('capsuleVersion', 1),
              'previewOnly': True, 'status': 'preview_ready', 'preview': {'orientaciones': {}}}
    if job.get('renderId'):
        result['renderId'] = job['renderId']
    for orient, stem in (('vertical', 'capsula-9x16'), ('horizontal', 'capsula-16x9')):
        stills = sorted(glob.glob(os.path.join(out, stem+'-t*s.png')),
                        key=lambda p: float(os.path.basename(p).rsplit('-t', 1)[1][:-5]))
        files = [stem+'.mp4'] + [os.path.basename(p) for p in stills]
        urls = []
        for filename in files:
            path = os.path.join(out, filename)
            if upload:
                with open(path, 'rb') as fh:
                    response = post('/capsula/url/preview-upload', {'ref': job['ref'],
                        'capsuleVersion': result['capsuleVersion'], 'renderId': job.get('renderId'), 'filename': filename,
                        'mime': 'video/mp4' if filename.endswith('.mp4') else 'image/png',
                        'base64': base64.b64encode(fh.read()).decode()})
                urls.append(response['url'])
            else:
                urls.append(path)
        result['preview']['orientaciones'][orient] = {'url': urls[0], 'stills': urls[1:]}
    with open(os.path.join(out, 'preview.json'), 'w') as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    if upload:
        post('/capsula/url/estado', result)
    return result

def prepare_editor_media(job, out, allow_local=False, cache_root=None):
    """Fetch only declared media; cached filenames are hashes, never URL path fragments."""
    doc = job.get('capsula')
    if not doc:
        return
    if cache_root:
        os.makedirs(cache_root, exist_ok=True)
    for item in doc.get('media') or []:
        src = item['src']
        if src.startswith('https://'):
            ext = '.mp4' if item['tipo'] == 'video' else '.img'
            name = 'media-'+hashlib.sha256(src.encode()).hexdigest()[:20]+ext
            target = os.path.join(out, name)
            if not os.path.exists(target):
                urllib.request.urlretrieve(src, target)
            item['localFile'] = name
        elif allow_local and not os.path.isabs(src) and '..' not in src.split('/') and os.path.isfile(os.path.join(out, src)):
            item['localFile'] = src
        elif allow_local and os.path.isfile(src):
            name = 'media-'+hashlib.sha256(src.encode()).hexdigest()[:20]+os.path.splitext(src)[1]
            shutil.copy(src, os.path.join(out, name))
            item['localFile'] = name
        else:
            raise ValueError('media no accesible: '+src[:150])
        if item['tipo'] == 'video':
            directory = 'frames-'+hashlib.sha256(src.encode()).hexdigest()[:20]
            frames = os.path.join(out, directory)
            cached_frames = os.path.join(cache_root, directory) if cache_root else frames
            if not os.path.isfile(os.path.join(cached_frames, '.complete')):
                partial = cached_frames+'.partial'
                os.makedirs(partial, exist_ok=True)
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(out, item['localFile']),
                    '-t', str(min(180, item['t'][1]-item['t'][0])), '-vf', 'scale=1080:-2,fps=25',
                    os.path.join(partial, 'f%05d.png')], check=True)
                if os.path.isdir(cached_frames):
                    shutil.rmtree(cached_frames)
                os.replace(partial, cached_frames)
                with open(os.path.join(cached_frames, '.complete'), 'w') as fh:
                    fh.write('25 fps\n')
            if cache_root and not os.path.lexists(frames):
                os.symlink(os.path.abspath(cached_frames), frames, target_is_directory=True)
            item['localFrames'] = directory

def process_job(job, real=False, upload_preview=False, allow_local=False, output_root=None):
    job = json.loads(json.dumps(job))  # Local filenames must never alter the stored editable draft.
    ver = job.get('capsuleVersion') or 1
    suffix = '-preview' if job.get('previewOnly') else ''
    # Draft revisions at the same capsuleVersion must not reuse a stale render.
    digest = hashlib.sha256(json.dumps(job.get('capsula') or job.get('guion'), sort_keys=True).encode())
    # Renderer fixes must invalidate an earlier render of the same draft too.
    for dependency in ('render_url.py', 'capsula_text.py', 'capsula_document.py', 'plantilla_v5.py'):
        with open(os.path.join(BASE, dependency), 'rb') as fh:
            digest.update(fh.read())
    fingerprint = digest.hexdigest()[:12]
    if job.get('previewOnly'):
        render_id = str(job.get('renderId') or fingerprint)
        if not all(c.isalnum() or c == '-' for c in render_id):
            raise ValueError('renderId inválido')
        suffix += '-'+render_id
    out = os.path.join(output_root or os.path.join(BASE, 'desde-url'), job['ref'].split(':')[1] + ('' if ver == 1 else f'-v{ver}') + suffix)
    os.makedirs(out, exist_ok=True)
    print(f"· {job['ref']} · versión {ver}" + (' · SOLO PREVIEW' if job.get('previewOnly') else ''))
    with open(os.path.join(out, 'encargo.json'), 'w') as fh:
        json.dump(job, fh, indent=1, ensure_ascii=False)
    prepare_editor_media(job, out, allow_local=allow_local,
                         cache_root=os.path.join(output_root or os.path.join(BASE, 'desde-url'), '.media-cache'))
    with open(os.path.join(out, 'guion.json'), 'w') as fh:
        json.dump(guion_v5(job), fh, indent=1, ensure_ascii=False)
    for name in ('logo.png', 'plantilla_v5.py', 'render_url.py', 'capsula_text.py'):
        shutil.copy(os.path.join(PLANT if name == 'logo.png' else BASE, name), out)
    if not any(m.get('role') == 'background' and m.get('localFile') for m in (job.get('capsula') or {}).get('media', [])):
        broll(job, out)
    stamp = os.path.join(out, '.render-fingerprint')
    cached = open(stamp).read().strip() if os.path.exists(stamp) else ''
    if cached != fingerprint or not all(os.path.exists(os.path.join(out, f)) for f in ('capsula-9x16.mp4', 'capsula-16x9.mp4')):
        subprocess.run([sys.executable, 'render_url.py'], cwd=out, check=True)
        with open(stamp, 'w') as fh:
            fh.write(fingerprint)
    if job.get('previewOnly'):
        return preview_result(job, out, upload_preview)
    publicar(job, out, real)
    return {'out': out}

def main():
    real = '--publicar' in sys.argv; solo = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else None
    local = sys.argv[sys.argv.index('--job') + 1] if '--job' in sys.argv else None
    output_root = sys.argv[sys.argv.index('--output-root') + 1] if '--output-root' in sys.argv else None
    jobs = [json.load(open(local))] if local else [j for j in get(f'{API}/capsula/url/cola')['jobs'] if not solo or j['ref'] == solo]
    print(f'{len(jobs)} encargo(s) en cola')
    for job in jobs:
        process_job(job, real=real, upload_preview=not local or '--upload-preview' in sys.argv, allow_local=bool(local), output_root=output_root)
if __name__ == '__main__': main()
