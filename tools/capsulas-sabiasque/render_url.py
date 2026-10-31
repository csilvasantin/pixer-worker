"""render_url.py — render v5 de una cápsula «¿Sabías que?» encargada desde el Creador (URL).
Es render_v2.py (Taalas) generalizado: cifra opcional (si no hay, titular grande), unidad del guion,
b-roll opcional (vídeo de la fuente o su miniatura) y crédito del guion. Misma plantilla_v5.
Uso: cd <carpeta con guion.json, logo.png y broll/> && python3 render_url.py"""
import json, math, subprocess, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plantilla_v5 import PRE, CIERRE_S, T_TOTAL_V51, barra_progreso, secuencia, fit_line, linea_fuente
from text_positions import normalize_positions, shifted_xy, SCHEMA as TEXT_POSITION_SCHEMA
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from capsula_text import fit_text, draw_spans
with open('guion.json',encoding='utf-8') as source:
    G=json.load(source)
C=G['capsulas'][0]
TEXT_POSITIONS=normalize_positions(G.get('textPositions'))
if TEXT_POSITIONS and G.get('textPositionSchema') != TEXT_POSITION_SCHEMA: raise ValueError('unsupported-text-position-schema')
FPS=25
# v5.7: cartelas opcionales. Guiones sin «cartelas» (anteriores a v5.7) conservan las dos.
_CT=C.get('cartelas') or {'preroll':True,'postroll':True}
PRE_ON=bool(_CT.get('preroll')); POST_ON=bool(_CT.get('postroll'))
OFF=0 if PRE_ON else 2   # el guion conserva coordenadas clásicas; el editor usa segundos de salida
POST=CIERRE_S if POST_ON else 0
T=float(C.get('duracion_s') or ((2 if PRE_ON else 0)+12+POST))
CUERPO=T-(2 if PRE_ON else 0)-POST
EDITOR=G.get('capsulaEditor') or {}
# v5.2: la cartela inicial usa la foto/miniatura de la fuente (fuente.jpg) de fondo, difuminada y oscurecida.
FOTO=next((p for p in ('fuente.jpg','fuente.png','fuente.webp') if os.path.exists(p)),None)
RED=(31,111,235); INK=(28,28,30); GREY=(95,95,100)
try:
    _color=(G.get('saga') or {}).get('color', '#1F6FEB').lstrip('#')
    RED=tuple(int(_color[i:i+2],16) for i in (0,2,4))
except (ValueError,TypeError): pass
ANTON='/usr/share/fonts/truetype/sand-box/google/Antonio/Antonio-VariableFont_wght.ttf'
if os.environ.get('CAPSULE_FONT_DIR'): ANTON=os.path.join(os.environ['CAPSULE_FONT_DIR'],'Antonio-Variable.ttf')
OSW='/usr/share/fonts/truetype/sand-box/google/Oswald/Oswald-VariableFont_wght.ttf'
if os.environ.get('CAPSULE_FONT_DIR'): OSW=os.path.join(os.environ['CAPSULE_FONT_DIR'],'Oswald-Variable.ttf')
INTER='/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
if os.environ.get('CAPSULE_FONT_DIR'): INTER=os.path.join(os.environ['CAPSULE_FONT_DIR'],'Inter-Variable.ttf')
_fc={}
def F(p,s,w):
    is_inter = p == INTER
    if not os.path.exists(p):
        # Official Linux fonts remain preferred. macOS previews can use local template fonts.
        p=next((v for v in (os.environ.get('CAPSULA_FONT_'+('INTER' if p==INTER else 'OSW' if p==OSW else 'ANTON'), ''),
            '/System/Library/Fonts/Supplemental/Arial Narrow.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf') if v and os.path.isfile(v)), p)
    k=(p,s,w)
    if k not in _fc:
        f=ImageFont.truetype(p,s)
        try: f.set_variation_by_axes([14,w] if is_inter else [w])
        except Exception: pass
        _fc[k]=f
    return _fc[k]
LOGO=Image.open('logo.png').convert('RGBA'); LOGO=LOGO.crop(LOGO.getbbox())
def eo(x): x=max(0,min(1,x)); return 1 if x>=1 else 1-2**(-10*x)
def eob(x): x=max(0,min(1,x)); c=1.70158; return 1+(c+1)*(x-1)**3+c*(x-1)**2
def wrap(d,txt,font,maxw):
    out=[];cur=''
    for w in txt.split():
        t=(cur+' '+w).strip()
        if d.textlength(t,font=font)<=maxw: cur=t
        else: out.append(cur);cur=w
    out.append(cur);return out
_g={}
def grid(W,H):
    if (W,H) not in _g:
        w,h=W//4,H//4; y,x=np.mgrid[0:h,0:w].astype(np.float32); _g[(W,H)]=(x/w,y/h,w,h)
    return _g[(W,H)]
P=np.random.default_rng(7).random((40,4))
def background(t,W,H,mode):
    x,y,w,h=grid(W,H); base=np.array([247,245,240],np.float32)
    if mode=='brand':
        cx=0.5+0.15*math.sin(t*1.3); cy=0.5+0.1*math.cos(t)
        r=np.sqrt((x-cx)**2*(w/h)**2+(y-cy)**2); g=np.clip(1-r*1.6,0,1)[...,None]
        img=base*(1-0.10*g)+np.array([104,152,64],np.float32)*0.10*g
    else:
        p=(x*0.7+y*0.5+t*0.12)%1.0; k=(0.5+0.5*np.sin(2*np.pi*p))[...,None]
        img=np.array([230,240,252],np.float32)*k+np.array([238,246,250],np.float32)*(1-k)
        for i,(amp,fr,sp,yy) in enumerate([(0.05,3.0,1.6,0.30),(0.04,4.5,-1.1,0.55),(0.06,2.2,0.8,0.82)]):
            curve=yy+amp*np.sin(2*np.pi*fr*x+sp*t+i); band=np.exp(-((y-curve)/0.010)**2)[...,None]
            img=img*(1-0.22*band)+np.array(RED,np.float32)*0.22*band
        for px,py,s,v in P:
            cx=(px+0.02*math.sin(t*0.8+v*9))%1; cy=(py-t*0.02*(0.5+v))%1
            dot=np.exp(-(((x-cx)*w/h)**2+(y-cy)**2)/(0.00008+0.0002*s))[...,None]
            img=img*(1-0.25*dot)+np.array(RED,np.float32)*0.25*dot
    return Image.fromarray(np.clip(img,0,255).astype(np.uint8)).resize((W,H),Image.BILINEAR).convert('RGBA')
def text_box(layer,key,xy,s,font,col,a):
    width,height=layer.size
    txt(layer,shifted_xy(TEXT_POSITIONS,key,width,height,*xy),s,font,col,a)
def txt(layer,xy,s,font,col,a):
    if a>0: ImageDraw.Draw(layer).text(xy,s,font=font,fill=col+(int(255*a),))
_ff={}
def foto_fondo(W,H,p=0):
    if not FOTO: return None
    if (W,H) not in _ff:
        from PIL import ImageFilter, ImageEnhance
        f=Image.open(FOTO).convert('RGB'); s=max(W/f.width,H/f.height)*1.12
        f=f.resize((int(f.width*s)+1,int(f.height*s)+1),Image.LANCZOS)
        f=f.filter(ImageFilter.GaussianBlur(radius=int(min(W,H)*0.018))); f=ImageEnhance.Brightness(f).enhance(0.42)
        v=Image.new('L',f.size,0); ImageDraw.Draw(v).ellipse([-f.width*0.2,-f.height*0.2,f.width*1.2,f.height*1.2],fill=255)
        from PIL import ImageFilter as IF; v=v.filter(IF.GaussianBlur(min(W,H)*0.15))
        f=Image.composite(f,Image.new('RGB',f.size,(0,0,0)),v); _ff[(W,H)]=f
    f=_ff[(W,H)]; p=max(0,min(1,p)); z=1+0.06*p; cw,ch=int(W*1.0),int(H*1.0)
    big=f.resize((int(f.width*z),int(f.height*z)),Image.BILINEAR) if p>0 else f
    x0=(big.width-cw)//2; y0=(big.height-ch)//2
    return big.crop((x0,y0,x0+cw,y0+ch)).convert('RGBA')
def logo_at(im,cx,cy,lw,a,scale=1,claro=False):
    lw=max(2,int(lw*scale)); lg=LOGO.resize((lw,int(LOGO.height*lw/LOGO.width)),Image.LANCZOS)
    if claro: w=Image.new('RGBA',lg.size,(255,255,255,0)); w.putalpha(lg.split()[3]); lg=w
    if a<1: lg.putalpha(lg.split()[3].point(lambda p:int(p*a)))
    im.alpha_composite(lg,(int(cx-lw/2),int(cy-lg.height/2))); return lg.height
def brand_card(t0,t,W,H,V,u,out=False):
    if out:
        # v5.1: cartela final FIJA. Corte seco, sin fundido, zoom ni animación (fondo congelado).
        im=background(0,W,H,'brand'); d=ImageDraw.Draw(im)
        lh=logo_at(im,W/2,H*0.42,W*(0.62 if V else 0.40),1,1); y0=H*0.42+lh/2+50*u; L=Image.new('RGBA',(W,H))
        f=F(INTER,int((58 if V else 56)*u),600)
        for i,s in enumerate(wrap(d,C['postroll']['claim'],f,W*0.86)):
            text_box(L,'claim',((W-d.textlength(s,font=f))/2,y0+i*72*u),s,f,INK,1)
        # v5.4: única mención de la fuente en toda la cápsula, pequeña y gris, al pie del cierre.
        src=(C['remate'].get('fuente') or {}).get('texto') or ''
        if src:
            fs_=F(INTER,int(28*u),500); src='Vídeo original: '+re.sub(r'^(Fuente|Source)\s*:\s*','',src)
            text_box(L,'fuente',((W-d.textlength(src,font=fs_))/2,H-int(150*u)),src,fs_,(150,150,155),1)
        im.alpha_composite(L); return im
    # v5.1: «¿Sabías que?» ENCIMA del logo; la tipología (categoría de la cápsula) DEBAJO.
    # v5.2: con foto de la fuente, fondo = foto difuminada y oscurecida (zoom lento), logo y textos claros.
    if not V and vertical_src(): return bandas_card(t-t0,W,H,u)
    lt=t-t0; dark=foto_fondo(W,H) is not None
    im=foto_fondo(W,H,lt/2) if dark else background(t,W,H,'brand'); d=ImageDraw.Draw(im)
    a=eo(lt/0.6); sc=0.7+0.3*eob(lt/0.8)+0.015*math.sin(t*2.5)
    lh=logo_at(im,W/2,H*0.45,W*(0.56 if V else 0.34),a,sc,claro=dark)
    L=Image.new('RGBA',(W,H))
    f=F(OSW,int((104 if V else 92)*u),700); ft=C['preroll'].get('titulo') or '¿Sabías que?'
    a1=eo((lt-0.15)/0.5); ya=H*0.45-lh/2-int((150 if V else 130)*u)+(1-a1)*(-30*u)
    text_box(L,'marca',((W-d.textlength(ft,font=f))/2,ya),ft,f,(120,175,255) if dark else RED,a1)
    a2=eo((lt-0.35)/0.5); dy=(1-a2)*40*u; y0=H*0.45+lh/2+44*u+dy
    fk=F(OSW,int((84 if V else 76)*u),700); tip=C['preroll'].get('tipologia') or ''
    if tip: text_box(L,'marca',((W-d.textlength(tip,font=fk))/2,y0),tip,fk,(255,255,255) if dark else INK,a2)
    f2=F(INTER,int(42*u),600); s2=C['preroll'].get('subtitulo') or ''; a3=eo((lt-0.6)/0.5)
    s2=''  # v5.4: sin subtítulo en la cartela inicial (repetía el titular del cuerpo)
    if s2: txt(L,((W-d.textlength(s2,font=f2))/2,y0+(110 if tip else 0)*u+(1-a3)*30*u),s2,f2,(220,220,225) if dark else GREY,a3)
    im.alpha_composite(L)
    return im
def panel(im,t,a,bx,by,bw,bh,u):
    Pn=Image.new('RGBA',im.size); pd=ImageDraw.Draw(Pn)
    pd.rounded_rectangle([bx,by,bx+bw,by+bh],radius=int(24*u),fill=(255,255,255,int(200*a)),outline=(225,220,212,int(255*a)),width=2)
    cols=[3,5,5,2]; nodes=[]
    for ci,nc in enumerate(cols):
        xx=bx+bw*(0.12+0.76*ci/(len(cols)-1))
        nodes.append([(xx,by+bh*(0.5+(j-(nc-1)/2)*0.8/max(nc,1))+3*u*math.sin(t*2+ci+j)) for j in range(nc)])
    for ci in range(len(cols)-1):
        for j,p1 in enumerate(nodes[ci]):
            for k,p2 in enumerate(nodes[ci+1]):
                w=0.5+0.5*math.sin(t*3-ci*1.5+j*0.7+k*1.1)
                pd.line([p1,p2],fill=RED+(int((40+150*w)*a),),width=max(1,int(2*u)))
    r=int(12*u)
    for ci,col in enumerate(nodes):
        for j,(xx,yy) in enumerate(col):
            g=0.5+0.5*math.sin(t*4-ci*1.2+j)
            pd.ellipse([xx-r,yy-r,xx+r,yy+r],fill=RED+(int((120+135*g)*a),),outline=(255,255,255,int(255*a)),width=2)
    im.alpha_composite(Pn)
BROLL=None
def broll_n():
    bg=next((m for m in EDITOR.get('media',[]) if m.get('role')=='background'),None)
    if bg:
        return max(1,len(media_frames(bg)))
    import glob; return len(glob.glob('broll/f*.png'))
def broll(i):
    global BROLL
    bg=next((m for m in EDITOR.get('media',[]) if m.get('role')=='background'),None)
    if bg: return media_image(bg,i/FPS)
    if BROLL is None:
        import glob; BROLL=sorted(glob.glob('broll/f*.png'))
    return Image.open(BROLL[max(0,min(len(BROLL)-1,i))]).convert('RGBA')
def kenburns(im,p):
    p=max(0,min(1,p)); z=1.0+0.08*p; w,h=im.size; cw,ch=int(w/z),int(h/z); x0=int((w-cw)*p*0.6); y0=int((h-ch)/2)
    return im.crop((x0,y0,x0+cw,y0+ch)).resize((w,h),Image.LANCZOS)
def fmt(n): return f"{n:,}".replace(',','.')
# v5.3 (22-oct-2026, reglas de Carlos para todas las tipologías):
#  · el vídeo de la fuente está presente durante TODA la explicación (2 s → cierre), en bucle si es más corto;
#  · fuente vertical en 16x9: vídeo a la DERECHA a toda la altura, textos a la IZQUIERDA;
#  · fuente vertical en 9x16: vídeo a pantalla completa (protagonista) con franjas oscuras degradadas arriba
#    (título y logo) y abajo (titular + gancho/giro/remate + fuente), crédito y «Toca para ver el original» en medio;
#  · fuente horizontal: la composición de siempre (caja del vídeo a la derecha en 16x9, en medio en 9x16), pero fija.
E0=2.0
_media_frames={}
def safe_local(value):
    if not value or os.path.isabs(value) or '..' in value.split('/'):
        raise ValueError('Ruta de media no controlada')
    return value
def media_frames(item):
    import glob
    directory=item.get('localFrames')
    if not directory: return []
    safe_local(directory)
    if directory not in _media_frames: _media_frames[directory]=sorted(glob.glob(os.path.join(directory,'f*.png')))
    return _media_frames[directory]
def media_image(item,seconds):
    frames=media_frames(item)
    filename=frames[int(max(0,seconds)*FPS)%len(frames)] if frames else safe_local(item.get('localFile'))
    image=Image.open(filename).convert('RGBA'); crop=item.get('recorte')
    if crop:
        x,y=crop.get('x',0),crop.get('y',0); w,h=crop.get('w',crop.get('width',1)),crop.get('h',crop.get('height',1))
        image=image.crop((int(x*image.width),int(y*image.height),int((x+w)*image.width),int((y+h)*image.height)))
    return image
def editor_frame(seconds,base):
    for item in EDITOR.get('media',[]):
        if item.get('role')=='background': continue
        a,b=item['t']
        if not a<=seconds<b: continue
        overlay=media_image(item,seconds-a)
        pos=item.get('posicion') or {'x':0.18,'y':0.25,'w':0.64,'h':0.38}
        x,y,w,h=[float(pos.get(k,d)) for k,d in (('x',.18),('y',.25),('w',.64),('h',.38))]
        overlay.thumbnail((max(1,int(base.width*w)),max(1,int(base.height*h))),Image.Resampling.LANCZOS)
        base.alpha_composite(overlay,(int(base.width*x+(base.width*w-overlay.width)/2),int(base.height*y+(base.height*h-overlay.height)/2)))
    return base
def bfr(t):
    seconds=t-OFF
    backgrounds=[m for m in EDITOR.get('media',[]) if m.get('role')=='background']
    if backgrounds:
        # The background persists for the whole capsule; a short video loops.
        bg=next((m for m in backgrounds if m['t'][0]<=seconds<m['t'][1]),backgrounds[0])
        image=media_image(bg,max(0,seconds-bg['t'][0]))
        return editor_frame(seconds,image)
    n=broll_n()
    if n<=1: return editor_frame(seconds,kenburns(broll(0),max(0,(t-E0)/max(.001,CUERPO))))
    return editor_frame(seconds,broll(int(max(0,t-E0)*FPS)%n))
def vertical_src():
    return broll_n()>0 and broll(0).height>broll(0).width
def cover(fr,W,H):
    s=max(W/fr.width,H/fr.height); fr=fr.resize((int(fr.width*s)+1,int(fr.height*s)+1),Image.LANCZOS)
    x0=(fr.width-W)//2; y0=(fr.height-H)//2; return fr.crop((x0,y0,x0+W,y0+H))
def grad(W,H,y0,y1,a0,a1):
    g=np.linspace(a0,a1,max(1,y1-y0),dtype=np.float32)[:,None].repeat(W,1)
    m=Image.new('L',(W,H),0); m.paste(Image.fromarray(np.clip(g,0,255).astype(np.uint8)),(0,y0)); return m
_vertical_shadows={}
def vertical_shadows(W,H):
    if (W,H) not in _vertical_shadows:
        mask=Image.fromarray(np.maximum(np.array(grad(W,H,0,int(H*0.20),220,0)),np.maximum(np.array(grad(W,H,int(H*0.46),int(H*0.60),0,225)),np.array(grad(W,H,int(H*0.60),H,225,235)))))
        _vertical_shadows[(W,H)]=Image.composite(Image.new('RGBA',(W,H),(8,8,12,255)),Image.new('RGBA',(W,H)),mask)
    return _vertical_shadows[(W,H)]
_text_layouts={}
# v5.4: sin pastilla ni texto. Pista sutil dentro del vídeo: icono pequeño de reproducir con un leve
# resplandor que respira, en la esquina superior derecha del vídeo. La interactividad la da el modal del Stock.
def play_hint(im,x1,y1,u,a,t):
    return  # v5.6: sin icono; la interactividad la da el modal (cursor de mano)
    if a<=0: return
    from PIL import ImageFilter
    r=int(26*u); g=int(r*2.6); cx,cy=x1-g//2,y1+g//2; pulse=0.55+0.25*(0.5+0.5*math.sin(t*2.4))
    G_=Image.new('RGBA',(g,g)); ImageDraw.Draw(G_).ellipse([g/2-r*1.05,g/2-r*1.05,g/2+r*1.05,g/2+r*1.05],fill=(255,255,255,int(150*a*pulse)))
    G_=G_.filter(ImageFilter.GaussianBlur(r*0.45)); im.alpha_composite(G_,(cx-g//2,cy-g//2))
    D=ImageDraw.Draw(im); D.ellipse([cx-r,cy-r,cx+r,cy+r],fill=(15,15,20,int(110*a)),outline=(255,255,255,int(220*a)),width=max(2,int(2.5*u)))
    k=r*0.42; D.polygon([(cx-k*0.75,cy-k),(cx-k*0.75,cy+k),(cx+k*1.05,cy)],fill=(255,255,255,int(235*a)))
def headline(L,d,t,x,y,tw,V,u,col,maxl,fsz=None):
    cf=C['gancho'].get('cifra') or {}
    if cf.get('hasta'):
        p=eo((t-2)/2.4); val=cf.get('desde',0)+(cf['hasta']-cf.get('desde',0))*p
        n=int(round(val/10))*10 if cf['hasta']>=1000 else (round(val,1) if cf['hasta']!=int(cf['hasta']) else int(round(val)))
        fc=F(ANTON,int((220 if V else 220)*u),700)
        text_box(L,'heading',(x,y),fmt(n) if isinstance(n,int) else str(n).replace('.',','),fc,col,eo((t-2)/0.3))
        if cf.get('unidad'): text_box(L,'unidad',(x+int(8*u),y+int(260*u)),cf['unidad'],F(OSW,int(64*u),700),RED if col==INK else (120,175,255),eo((t-2.3)/0.5))
        return y+int(350*u)
    if not EDITOR:
        fh=F(OSW,int((fsz or (84 if V else 80))*u),700); ls=wrap(d,C['preroll']['subtitulo'] or G['objeto'],fh,tw)[:maxl]
        lh_=int((fsz or 80)*1.2*u)
        for i,s_ in enumerate(ls): text_box(L,'heading',(x,y+i*lh_),s_,fh,col,eo((t-2-i*0.12)/0.4))
        return y+len(ls)*lh_
    title=C['preroll']['subtitulo'] or G['objeto']
    layout=('headline',title,int((fsz or (84 if V else 80))*u),tw,maxl,max(10,int(18*u)))
    if layout not in _text_layouts:
        _text_layouts[layout]=fit_text(d,title,lambda n:F(OSW,n,700),layout[2],tw,maxl,minsize=layout[5])
    fh,ls,size=_text_layouts[layout]
    lh_=size*1.2
    spans=[s for s in EDITOR.get('spans',[]) if s['campo']=='titulo']
    for i,(s_,offset) in enumerate(ls): draw_spans(ImageDraw.Draw(L),shifted_xy(TEXT_POSITIONS,'heading',L.width,L.height,x,y+i*lh_),s_,offset,fh,col,eo((t-2-i*.12)/.4),spans,RED)
    return y+len(ls)*lh_
def lines(L,d,t,x,y,tw,u,cols3,size):
    if not EDITOR:
        keys=('gancho','giro','remate')
        items=[(key,*C[key]['linea_t']) for key in keys]
        cols=dict(zip(keys,cols3)); fl=F(INTER,int(size*u),700)
        for key,al,dx in secuencia(t,items):
            for i,line in enumerate(wrap(d,C[key]['linea'],fl,tw)):
                text_box(L,key,(x-dx*u,y+i*int(size*1.28*u)),line,fl,cols[key],al)
        return
    maxheight=L.height-y-int(32*u)
    for index,key in enumerate(('gancho','giro','remate')):
        text=C[key]['linea']; a,b=C[key]['linea_t']
        if not a<=t<b: continue
        # One active message at a time, including across timing edits.
        alpha=eo((t-a)/min(.5,(b-a)/3)); dx=(1-alpha)*60*u
        layout=('beat',text,size,u,tw,maxheight)
        chosen=_text_layouts.get(layout)
        if not chosen:
            for candidate in range(max(12,int(size*u)),max(11,int(14*u)),-1):
                try:
                    font,wrapped,actual=fit_text(d,text,lambda n:F(INTER,n,700),candidate,tw,
                        max(1,int(maxheight/(candidate*1.28))),minsize=candidate)
                    if len(wrapped)*actual*1.28<=maxheight: chosen=(font,wrapped,actual);break
                except ValueError: pass
            if not chosen: raise ValueError(f'{key}: texto demasiado largo para la zona disponible')
            _text_layouts[layout]=chosen
        font,wrapped,actual=chosen
        spans=[s for s in EDITOR.get('spans',[]) if s['campo']==key]
        for i,(line,offset) in enumerate(wrapped):
            draw_spans(ImageDraw.Draw(L),shifted_xy(TEXT_POSITIONS,key,L.width,L.height,x-dx,y+i*actual*1.28),line,offset,font,cols3[index],alpha,spans,RED)
# v5.5 (22-oct-2026, Carlos · todas las tipologías): fuente VERTICAL en 16x9 → la imagen va centrada en su
# proporción y las bandas laterales (desenfoque muy apagado de la propia imagen, sin cajas) llevan el logo
# arriba a la izquierda y «¿Sabías que?» + tipología a la derecha. En la cartela, la imagen central pasa de
# borrosa a nítida mientras entran los textos. El cuerpo mantiene las mismas bandas (coherencia): vídeo en el
# centro, titular y gancho/giro/remate en la banda izquierda bajo el logo, «¿Sabías que?» + tipología a la derecha.
REVEAL=1.6
_bd={}
def bandas_bg(W,H):
    if (W,H) not in _bd:
        from PIL import ImageFilter, ImageEnhance
        f=cover(broll(0).convert('RGB'),W,H).filter(ImageFilter.GaussianBlur(int(H*0.05)))
        _bd[(W,H)]=ImageEnhance.Brightness(f).enhance(0.22).convert('RGBA')
    return _bd[(W,H)].copy()
def centro(W,H):
    fr=broll(0); cw=int(H*fr.width/fr.height); return (W-cw)//2,cw
# v5.6: banda IZQUIERDA = logo arriba + «¿Sabías que?» + tipología; banda DERECHA = explicación.
def lado_marca(L,d,W,H,u,lt,x0):
    ft=C['preroll'].get('titulo') or '¿Sabías que?'; tip=C['preroll'].get('tipologia') or ''
    cx=x0/2; f=F(OSW,int(84*u),700); fk=F(OSW,int(64*u),700)
    a1=eo((lt-0.2)/0.6); a2=eo((lt-0.45)/0.6)
    text_box(L,'marca',(cx-d.textlength(ft,font=f)/2-(1-a1)*60*u,H*0.40),ft,f,(120,175,255),a1)
    if tip: text_box(L,'marca',(cx-d.textlength(tip,font=fk)/2-(1-a2)*60*u,H*0.40+int(112*u)),tip,fk,(255,255,255),a2)
def logo_izq(im,u,a,dx=0):
    lw=int(240*u); logo_at(im,int(80*u)+lw/2-dx,int(95*u),lw,a,claro=True)
def bandas_card(lt,W,H,u):
    from PIL import ImageFilter
    im=bandas_bg(W,H); x0,cw=centro(W,H); fr=broll(0).convert('RGB').resize((cw,H),Image.LANCZOS)
    q=max(0,min(1,lt/REVEAL)); r=40*u*(1-q*q*(3-2*q))   # smoothstep: borroso → nítido a lo largo de 1,6 s
    if r>0.4: fr=fr.filter(ImageFilter.GaussianBlur(r))
    im.alpha_composite(fr.convert('RGBA'),(x0,0)); d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
    a=eo((lt-0.1)/0.6); logo_izq(im,u,a,(1-a)*60*u); lado_marca(L,d,W,H,u,lt,x0)
    im.alpha_composite(L); return im
def explain_bandas(t,W,H,u):
    im=bandas_bg(W,H); x0,cw=centro(W,H); im.alpha_composite(bfr(t).convert('RGBA').resize((cw,H),Image.LANCZOS),(x0,0))
    d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H)); mx=int(80*u)
    logo_izq(im,u,1); lado_marca(L,d,W,H,u,9,x0); xr=x0+cw+mx; tw=W-xr-mx
    y=headline(L,d,t,xr,int(H*0.24),tw,False,u,(255,255,255),4,fsz=60)
    lines(L,d,t,xr,max(y+int(40*u),int(H*0.56)),tw,u,((235,235,240),(140,190,255),(235,235,240)),42)
    im.alpha_composite(L); return im
def explain(t,W,H):
    V=H>W; u=min(W,H)/1080; mx=int(80*u); br=C['giro'].get('broll') or {}; fsrc=C['remate']['fuente']
    a=eo((t-E0)/0.4); vs=vertical_src() if broll_n() else False
    if not V and vs: return explain_bandas(t,W,H,u)
    if V and vs:
        # 9x16 + fuente vertical: vídeo a pantalla completa, franjas legibles.
        im=cover(bfr(t),W,H).convert('RGBA')
        if t-E0<0.7:
            from PIL import ImageFilter; im=im.filter(ImageFilter.GaussianBlur(24*u*(1-eo((t-E0)/0.7))))
        im.alpha_composite(vertical_shadows(W,H))
        d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
        text_box(L,'marca',(mx,int(50*u)),C['titulo'],F(OSW,int(72*u),700),(120,175,255),1); logo_at(im,W-mx-int(110*u),int(95*u),int(220*u),1,claro=True)
        play_hint(im,W-mx,int(H*0.20),u,a,t)
        y=headline(L,d,t,mx,int(H*0.60),W-2*mx,V,u,(255,255,255),2)
        lines(L,d,t,mx,max(y+int(30*u),int(H*0.75)),W-2*mx,u,((255,255,255),(140,190,255),(255,255,255)),60)
        im.alpha_composite(L); return im
    im=background(t,W,H,'explain'); d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
    text_box(L,'marca',(mx,int(50*u)),C['titulo'],F(OSW,int(72*u),700),RED,1)
    if broll_n():
        fr=bfr(t)
        if not V and vs:   # 16x9 + fuente vertical: vídeo a la derecha, a toda la altura.
            bh=H; bw=int(bh*fr.width/fr.height); bx=W-bw; by=0; rad=0
        elif not V:        # 16x9 + fuente horizontal: caja a la derecha (como v5.1), toda la explicación.
            bw=int(W*0.42); bh=int(bw*fr.height/fr.width); mh=int(H*0.56)
            if bh>mh: bw=int(bw*mh/bh); bh=mh
            bx=int(W*0.52); by=int(H*0.17); rad=int(20*u)
        else:              # 9x16 + fuente horizontal: caja ancha en medio.
            bw=W-2*mx; bh=int(bw*fr.height/fr.width); mh=int(H*0.30)
            if bh>mh: bw=int(bw*mh/bh); bh=mh
            bx=mx; by=int(H*0.375); rad=int(20*u)
        by+=int((1-a)*40*u) if rad else 0
        fr=fr.resize((bw,bh),Image.LANCZOS); m=Image.new('L',(bw,bh),0)
        ImageDraw.Draw(m).rounded_rectangle([0,0,bw-1,bh-1],radius=rad,fill=int(255*a)); fr.putalpha(m); im.alpha_composite(fr,(bx,by))
        play_hint(im,bx+bw-int(24*u),by+int(24*u),u,a,t)
        right=bx if not V else W
    else: right=W
    if not V: logo_at(im,min(right,W)-mx-int(110*u)+(0 if right==W else int(30*u)),int(95*u),int(220*u),1)
    else: logo_at(im,W-mx-int(110*u),int(95*u),int(220*u),1)
    if V:
        y=headline(L,d,t,mx,int(H*0.13),W-2*mx,V,u,INK,3); lines(L,d,t,mx,int(H*0.72),W-2*mx,u,(INK,RED,INK),64)
    else:
        tw=(right-2*mx) if right<W else int(W*0.44)
        y=headline(L,d,t,mx,int(H*0.20),tw,V,u,INK,3); lines(L,d,t,mx,max(y+int(30*u),int(H*(0.60 if right<W else 0.74))),tw if right<W else W-2*mx,u,(INK,RED,INK),56 if right<W else 60)
    im.alpha_composite(L); return im
def frame(t,W,H):
    u=min(W,H)/1080; V=H>W; tl=t+OFF   # tl = tiempo en la línea clásica (cartela 0–2, cuerpo 2–14, cierre 14–18)
    if PRE_ON and t<2: im=brand_card(0,t,W,H,V,u)
    elif POST_ON and t>=T-POST: im=brand_card(T-POST,t,W,H,V,u,out=True)
    else: im=explain(tl,W,H)
    # Credits stay in editable metadata; v5.7 only draws source attribution in
    # its optional postroll. Editor media must not add captions to the body.
    barra_progreso(im,min(t,T-POST) if t<T-POST else T,T,RED,u,abajo=True)  # en el cierre fijo, barra llena y quieta
    return im
STILLS=tuple(x for x in (1,5,7,10,15,17.5) if x<T)
def render(W,H,out):
    p=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
       '-f','lavfi','-i',f'anullsrc=r=48000:cl=stereo:d={T}',
       '-map','0:v','-map','1:a','-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-preset','medium','-c:a','aac','-b:a','128k','-t',str(T),'-movflags','+faststart',out],stdin=subprocess.PIPE)
    for i in range(round(FPS*T)):
        t=i/FPS; im=frame(t,W,H).convert('RGB'); p.stdin.write(im.tobytes())
        pass
    p.stdin.close()
    if p.wait()!=0: raise RuntimeError('ffmpeg no pudo generar el MP4')
    for s in STILLS: frame(s,W,H).convert('RGB').save(out.replace('.mp4',f'-t{s:g}s.png'))  # stills en el instante exacto
if __name__=='__main__':
    # v5.8: solo las orientaciones pedidas en el guion (formatos de plantilla_v5; por defecto ambas).
    from plantilla_v5 import ORIENT, formatos_de
    for o in formatos_de((G.get('capsulas') or [{}])[0].get('formatos'), G.get('orientacion')): render(*ORIENT[o])
