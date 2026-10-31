"""Plantilla v5 «¿Sabías que?» — piezas reutilizables (cualquier saga: tecnología, música…).
- barra_progreso(): barras superior e inferior (espejo), ancho = W*t/T en TODOS los segmentos, sin lectura de tiempo.
- secuencia(): muestra UNA línea a la vez (entra, se queda, sale) en lugar de apilar texto.
- linea_fuente(): fuente en una sola línea corta, gris, abajo.
Publicación: usar publicar_sabias_v5.py, que NO rellena «comment» (evita el bloque 💬 duplicado en pixeria.com/stock).
Tiempos por defecto (v5, 22-oct-2026 14:00): 15 s = preroll 2 + explicación 12 + postroll 1 (PRE, EXPL, POST).
estirar(t) convierte tiempos del esquema antiguo 2+11+2 al nuevo de forma proporcional.
Uso v5.1: from plantilla_v5 import CIERRE_S, T_TOTAL_V51, ...
Uso: from plantilla_v5 import barra_progreso, secuencia, linea_fuente, fit_line"""
import math
from PIL import Image, ImageDraw, ImageFont
T_TOTAL=15; PRE=2; POST=1; EXPL=T_TOTAL-PRE-POST   # 2+12+1 (cápsulas v5 publicadas hasta el 22-oct-2026)
# v5.1 (22-oct-2026 18:10, Carlos tras revisar #1798/#1799), para todas las tipologías:
# cartela de entrada = «¿Sabías que?» ENCIMA del logo y la tipología (categoría) DEBAJO;
# cartela final fija = entra por corte seco, sin fundido/zoom/animación, y dura CIERRE_S.
CIERRE_S=4; T_TOTAL_V51=PRE+EXPL+CIERRE_S   # 2+12+4 = 18 s
def estirar(t,viejo=(2,13),nuevo=(PRE,T_TOTAL-POST)):
    """Mapea un instante del tramo de explicación antiguo (2–13 s) al nuevo (2–14 s), proporcionalmente."""
    if t<=viejo[0]: return t
    return round(nuevo[0]+(t-viejo[0])*(nuevo[1]-nuevo[0])/(viejo[1]-viejo[0]),2)
def _eo(x): x=max(0,min(1,x)); return 1 if x>=1 else 1-2**(-10*x)
def barra_progreso(im,t,T,color,u,alto=14,abajo=True):
    """Barra superior (y espejo inferior si abajo=True): ancho = W*t/T, pista tenue, sin lectura de tiempo."""
    W,H=im.size; h=int(alto*u); fw=int(round(W*max(0,min(1,t/T))))
    for y0 in ([0,H-h-1] if abajo else [0]):
        im.alpha_composite(Image.new('RGBA',(W,h+1),color+(50,)),(0,y0))
        if fw>0: ImageDraw.Draw(im).rectangle([0,y0,fw-1,y0+h],fill=color+(255,))
    return fw
def secuencia(t,items):
    """items=[(texto,t0,t1),...] → [(texto,alpha,dx)] activos; fundido de 0.5 s de entrada y 0.35 s de salida."""
    out=[]
    for s,t0,t1 in items:
        if t0<=t<t1+0.35:
            a_in=_eo((t-t0)/0.5); a_out=1-max(0,min(1,(t-t1)/0.35))
            out.append((s,a_in*a_out,(1-a_in)*60))
    return out
def fit_line(d,s,path,size,maxw,minsize=18):
    while size>minsize:
        f=ImageFont.truetype(path,size)
        if d.textlength(s,font=f)<=maxw: return f
        size-=2
    return ImageFont.truetype(path,minsize)
def linea_fuente(L,s,font,x,y,col,a):
    if a>0: ImageDraw.Draw(L).text((x,y),s,font=font,fill=col+(int(255*a),))

# v5.8 (31-oct-2026, #capsula/#formato): orientación y formatos del encargo.
# job['formatos'] = ['vertical'] | ['horizontal'] | ambos; admite alias v/h/-v/-h/9x16/16x9/1080x1920/1920x1080.
ORIENT={'vertical':(1080,1920,'capsula-9x16.mp4'),'horizontal':(1920,1080,'capsula-16x9.mp4')}
_ALIAS={'v':'vertical','-v':'vertical','9x16':'vertical','1080x1920':'vertical','portrait':'vertical','vertical':'vertical',
        'h':'horizontal','-h':'horizontal','16x9':'horizontal','1920x1080':'horizontal','landscape':'horizontal','horizontal':'horizontal'}
def orient_de(v): return _ALIAS.get(str(v or '').strip().lower())
def formatos_de(src=None,orientacion=None):
    """Lista ordenada de orientaciones pedidas (sin duplicados). Sin datos → ambas (comportamiento anterior)."""
    if isinstance(src,dict): orientacion=orientacion or src.get('orientacion'); src=src.get('formatos')
    if isinstance(src,str): src=src.replace('+',',').replace(' ',',').split(',')
    out=[]
    for x in (src or []):
        o=orient_de(x)
        if o and o not in out: out.append(o)
    if not out: out=[orient_de(orientacion)] if orient_de(orientacion) else ['vertical','horizontal']
    return out
def resoluciones(formatos): return [f"{ORIENT[o][0]}x{ORIENT[o][1]}" for o in formatos_de(formatos)]
