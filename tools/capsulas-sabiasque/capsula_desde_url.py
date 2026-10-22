#!/usr/bin/env python3
"""URL → cápsula «¿Sabías que?» (plantilla v5).
    python3 capsula_desde_url.py <url> [--tipo tecnologia-xxx] [--salida /workspace/sabiasque/<tipo>/v1]
1. Descarga el vídeo con yt-dlp (mp4) + info.json a /workspace/capsulas-url/<id>/ (short.mp4, short.info.json).
2. Crea la carpeta de cápsula con guion.json de borrador: título, canal, URL, duración y timestamps sugeridos
   para b-roll (de los capítulos si existen; si no, por cambios de escena con ffmpeg scdet).
3. Copia plantilla_v5.py, publicar_sabias_v5.py, logo y un render_v1.py base (de tecnologia-taalas/v1).
Después: rellenar a mano cifra/líneas/fuente VERIFICADA en guion.json, extraer el b-roll
(ffmpeg -ss T -t 4 -i short.mp4 -vf "crop=...,fps=25" broll/f%03d.png) y lanzar python3 render_v1.py.
No publica nada."""
import json, os, re, shutil, subprocess, sys
BASE = os.path.dirname(os.path.abspath(__file__))
def arg(n, d=None): return sys.argv[sys.argv.index(n)+1] if n in sys.argv else d
def escenas(mp4, umbral=0.3):
    r = subprocess.run(['ffmpeg','-hide_banner','-i',mp4,'-vf',f'select=gt(scene\\,{umbral}),showinfo','-f','null','-'],capture_output=True,text=True)
    return [round(float(x),1) for x in re.findall(r'pts_time:([\d.]+)', r.stderr)]
def main():
    url = sys.argv[1]
    vid = subprocess.check_output(['yt-dlp','--get-id',url],text=True).strip()
    dl = f'/workspace/capsulas-url/{vid}'; os.makedirs(dl, exist_ok=True)
    mp4 = os.path.join(dl,'short.mp4')
    if not os.path.exists(mp4):
        subprocess.check_call(['yt-dlp','-f','bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b','--merge-output-format','mp4',
                               '--write-info-json','-o',os.path.join(dl,'short.%(ext)s'),url])
    info = json.load(open(os.path.join(dl,'short.info.json')))
    tipo = arg('--tipo', 'tecnologia-' + re.sub(r'[^a-z0-9]+','-',info.get('title','url').lower())[:24].strip('-'))
    out = arg('--salida', os.path.join(BASE, tipo, 'v1')); os.makedirs(out, exist_ok=True)
    cortes = [(c['start_time'], c['end_time']) for c in info.get('chapters') or []] or \
             [(t, round(t+4,1)) for t in (escenas(mp4) or escenas(mp4,0.15))[:6]]
    g = {"fecha": "", "plantilla": "plantilla_guion_v5", "saga": {"tema": "tecnología", "color": "#1F6FEB"},
         "tipo": tipo, "objeto": "RELLENAR", "fuente": "Fuente: RELLENAR (fuente primaria verificada)",
         "origen": {"url": url, "titulo": info.get('title'), "canal_youtube": info.get('channel') or info.get('uploader'),
                    "programa": "RELLENAR (programa original si es un recorte)", "duracion_s": info.get('duration'),
                    "fecha_subida": info.get('upload_date'), "video": mp4, "broll_sugerido": cortes, "recorte": "crop=W:H:X:Y"},
         "capsulas": [{"id": tipo+"-01", "version": "v1", "duracion_s": 15, "formatos": ["1920x1080","1080x1920"], "titulo": "¿Sabías que?",
            "preroll": {"t": [0,2], "texto": "¿Sabías que? Tecnología", "subtitulo": "RELLENAR"},
            "gancho": {"t": [2,5.05], "linea_t": [2.65,4.95], "cifra": {"desde": 0, "hasta": 0, "unidad": "", "easing": "easeOutExpo"}, "linea": "RELLENAR"},
            "giro": {"t": [5.05,10.73], "linea_t": [5.05,10.73], "linea": "RELLENAR", "broll": {"fichero": "broll/", "t_capsula": [5.05,9.05], "credito": "Vídeo: RELLENAR"}},
            "remate": {"t": [10.73,14], "linea_t": [10.95,15], "linea": "RELLENAR", "fuente": {"texto": "Fuente: RELLENAR", "url": "", "t": [2.65,14]}},
            "barra_progreso": {"t": [0,15], "posicion": "arriba y abajo (espejo)", "lectura": None},
            "audio": {"tipo": "silencio", "t": [0,15]}, "postroll": {"t": [14,15], "claim": "Connecting things to Internet"},
            "tags": ["capsula","sabiasque","tecnologia"]}]}
    gp = os.path.join(out,'guion.json')
    if not os.path.exists(gp): json.dump(g, open(gp,'w'), indent=1, ensure_ascii=False)
    ref = os.path.join(BASE,'tecnologia-taalas','v2')
    for f in ('plantilla_v5.py','publicar_sabias_v5.py','logo.png','admira-logo_green.svg','render_v2.py'):
        if os.path.exists(os.path.join(ref,f)) and not os.path.exists(os.path.join(out,f)): shutil.copy(os.path.join(ref,f), out)
    print(f'vídeo: {mp4}\nguion: {gp}\nb-roll sugerido (s): {cortes}')
if __name__ == '__main__': main()
