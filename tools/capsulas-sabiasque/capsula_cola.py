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
import json, os, shutil, subprocess, sys, urllib.request, datetime
BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import publicar_sabias_v5 as pub
API = os.environ.get('STOCK_API', 'https://api.admira.store')
UA = {'user-agent': 'Mozilla/5.0 admiranext-capsulas', 'origin': 'https://www.admira.studio'}
PLANT = next(p for p in (os.path.join(BASE, 'tecnologia-taalas', 'v2'), BASE) if os.path.exists(os.path.join(p, 'logo.png')))
COLORES = {'tecnología': '#1F6FEB'}
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return json.load(r)
def guion_v5(job):
    g = job['guion']; s = job['source']; tema = g.get('tema') or 'tecnología'
    hoy = datetime.date.today().isoformat(); slug = job['ref'].split(':')[1]
    cifra = g.get('cifra') or {}
    credito = 'Vídeo: ' + (s.get('author') or {'linkedin': 'LinkedIn', 'youtube': 'YouTube', 'tiktok': 'TikTok', 'x': 'X'}.get(s.get('kind'), s.get('kind') or 'fuente'))
    return {"fecha": hoy, "plantilla": "plantilla_guion_v5", "saga": {"tema": tema, "color": COLORES.get(tema, '#1F6FEB')},
        "tipo": f"url-{slug}", "objeto": g['objeto'], "fuente": g['fuente'],
        "origen": {"url": s['url'], "resuelta": s.get('resolvedUrl'), "clave": s.get('sourceKey'), "tipo": s.get('kind'), "encargo": job['ref']},
        "locucion": {"gancho": g['gancho'], "cifra": g['giro'], "idea": g['remate']},
        "idea_clave": g.get('idea', ''),
        "capsulas": [{"id": f"url-{slug}-01", "version": "v1", "duracion_s": 18, "plantilla": "v5.1", "formatos": ["1920x1080", "1080x1920"], "titulo": "¿Sabías que?",
            "preroll": {"t": [0, 2], "logo": "admira_oficial", "titulo": "¿Sabías que?", "tipologia": tema.capitalize(), "texto": f"¿Sabías que? {tema.capitalize()}", "subtitulo": g.get('subtitulo') or ''},
            "gancho": {"t": [2, 5.05], "linea_t": [2.65, 4.95], "linea": g['gancho'],
                       "cifra": ({"desde": 0, "hasta": cifra['hasta'], "unidad": cifra.get('unidad', ''), "easing": "easeOutExpo"} if cifra.get('hasta') else None)},
            "giro": {"t": [5.05, 10.73], "linea_t": [5.05, 10.73], "linea": g['giro'], "broll": {"fichero": "broll/", "t_capsula": [5.05, 9.05], "credito": credito}},
            "remate": {"t": [10.73, 14], "linea_t": [10.95, 14], "linea": g['remate'], "fuente": {"texto": g['fuente'], "url": s['url'], "t": [2.65, 14]}},
            "barra_progreso": {"t": [0, 18], "posicion": "arriba y abajo (espejo)", "lectura": None},
            "audio": {"tipo": "silencio", "t": [0, 15]}, "postroll": {"t": [14, 18], "logo": "admira_oficial", "claim": "Connecting things to Internet", "fijo": True},
            "tags": job.get('tags') or ['capsula', 'sabiasque']}]}
def broll(job, out):
    d = os.path.join(out, 'broll'); os.makedirs(d, exist_ok=True)
    if any(f.startswith('f') for f in os.listdir(d)): return
    s = job['source']
    if s.get('kind') in ('linkedin', 'youtube', 'tiktok', 'x', 'vimeo', 'instagram'):
        mp4 = os.path.join(out, 'fuente.mp4')
        try:
            if not os.path.exists(mp4):
                subprocess.run(['yt-dlp', '-q', '-f', 'bv*[ext=mp4][height<=1080]+ba/b[ext=mp4]/b', '--merge-output-format', 'mp4', '-o', mp4, s['url']], check=True, timeout=600)
            dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], text=True).strip() or 8)
            t0 = max(0, dur / 2 - 2)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.2f}', '-t', '4', '-i', mp4, '-vf', 'scale=1080:-2,fps=25', os.path.join(d, 'f%03d.png')], check=True)
            return
        except Exception as e: print('  b-roll vídeo no disponible:', e)
    if s.get('image'):
        try:
            img = os.path.join(out, 'fuente.jpg'); urllib.request.urlretrieve(s['image'], img)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', img, '-vf', 'scale=1080:-2', os.path.join(d, 'f001.png')], check=True)
        except Exception as e: print('  miniatura no disponible:', e)
def poster(png):
    import base64, io
    from PIL import Image
    im = Image.open(png).convert('RGB'); im.thumbnail((720, 720)); b = io.BytesIO(); im.save(b, 'JPEG', quality=82)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
def publicar(job, out, real):
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
        p['capsuleSource'] = {'sourceUrl': job['source']['url'], 'credit': br['credito'], 'broll': {'start': br['t_capsula'][0], 'end': br['t_capsula'][1]}, 'version': job.get('capsuleVersion') or 1}
        p['poster'] = poster(os.path.join(out, nombre.replace('.mp4', '-t5s.png')))
        if not real: print(f'  [ensayo] {orient}:', json.dumps({k: v for k, v in p.items() if k != 'base64'}, ensure_ascii=False)); continue
        req = urllib.request.Request(f"{pub.API}/stock/publish", data=json.dumps(p).encode(), method='POST',
              headers={'content-type': 'application/json', 'origin': 'https://www.pixeria.com', **pub.UA})
        with urllib.request.urlopen(req, timeout=300) as r: d = json.load(r)
        if not d.get('ok'): sys.exit(f'{orient}: rechazado: {d}')
        hechos[orient] = {'id': d['id'], 'url': d['url'], 'num': d.get('num'), 'version': ver, 'superseded': d.get('superseded'), 'resp': d}
        json.dump(hechos, open(hp, 'w'), indent=1, ensure_ascii=False); print(f"  {orient}: publicado → #{d.get('num')} {d['id']} · sustituye {d.get('superseded')}")
def main():
    real = '--publicar' in sys.argv; solo = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else None
    jobs = [j for j in get(f'{API}/capsula/url/cola')['jobs'] if not solo or j['ref'] == solo]
    print(f'{len(jobs)} encargo(s) en cola')
    for job in jobs:
        ver = job.get('capsuleVersion') or 1
        out = os.path.join(BASE, 'desde-url', job['ref'].split(':')[1] + ('' if ver == 1 else f'-v{ver}')); os.makedirs(out, exist_ok=True)
        print(f"· {job['ref']} · {job['guion']['objeto']} · {job['source']['url']}")
        json.dump(job, open(os.path.join(out, 'encargo.json'), 'w'), indent=1, ensure_ascii=False)
        json.dump(guion_v5(job), open(os.path.join(out, 'guion.json'), 'w'), indent=1, ensure_ascii=False)
        shutil.copy(os.path.join(PLANT, 'logo.png'), out); shutil.copy(os.path.join(BASE, 'plantilla_v5.py'), out)
        shutil.copy(os.path.join(BASE, 'render_url.py'), out)
        broll(job, out)
        if not (os.path.exists(os.path.join(out, 'capsula-9x16.mp4')) and os.path.exists(os.path.join(out, 'capsula-16x9.mp4'))):
            subprocess.run([sys.executable, 'render_url.py'], cwd=out, check=True)
        publicar(job, out, real)
if __name__ == '__main__': main()
