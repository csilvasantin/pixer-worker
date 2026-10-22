"""render_url.py — render v5 de una cápsula «¿Sabías que?» encargada desde el Creador (URL).
Es render_v2.py (Taalas) generalizado: cifra opcional (si no hay, titular grande), unidad del guion,
b-roll opcional (vídeo de la fuente o su miniatura) y crédito del guion. Misma plantilla_v5.
Uso: cd <carpeta con guion.json, logo.png y broll/> && python3 render_url.py"""
import json, math, subprocess, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plantilla_v5 import PRE, CIERRE_S, T_TOTAL_V51, barra_progreso, secuencia, fit_line, linea_fuente
import numpy as np
from PIL import Image, ImageDraw, ImageFont
G=json.load(open('guion.json',encoding='utf-8')); C=G['capsulas'][0]
FPS=25; T=T_TOTAL_V51; POST=CIERRE_S   # v5.1: 2 + 12 + 4 (cierre fijo)
# v5.2: la cartela inicial usa la foto/miniatura de la fuente (fuente.jpg) de fondo, difuminada y oscurecida.
FOTO=next((p for p in ('fuente.jpg','fuente.png','fuente.webp') if os.path.exists(p)),None)
RED=(31,111,235); INK=(28,28,30); GREY=(95,95,100)
ANTON='/usr/share/fonts/truetype/sand-box/google/Antonio/Antonio-VariableFont_wght.ttf'
OSW='/usr/share/fonts/truetype/sand-box/google/Oswald/Oswald-VariableFont_wght.ttf'
INTER='/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
_fc={}
def F(p,s,w):
    k=(p,s,w)
    if k not in _fc:
        f=ImageFont.truetype(p,s)
        try: f.set_variation_by_axes([w] if p!=INTER else [14,w])
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
            txt(L,((W-d.textlength(s,font=f))/2,y0+i*72*u),s,f,INK,1)
        # v5.4: única mención de la fuente en toda la cápsula, pequeña y gris, al pie del cierre.
        src=(C['remate'].get('fuente') or {}).get('texto') or ''
        if src:
            fs_=F(INTER,int(28*u),500); src='Vídeo original: '+re.sub(r'^(Fuente|Source)\s*:\s*','',src)
            txt(L,((W-d.textlength(src,font=fs_))/2,H-int(150*u)),src,fs_,(150,150,155),1)
        im.alpha_composite(L); return im
    # v5.1: «¿Sabías que?» ENCIMA del logo; la tipología (categoría de la cápsula) DEBAJO.
    # v5.2: con foto de la fuente, fondo = foto difuminada y oscurecida (zoom lento), logo y textos claros.
    lt=t-t0; dark=foto_fondo(W,H) is not None
    im=foto_fondo(W,H,lt/2) if dark else background(t,W,H,'brand'); d=ImageDraw.Draw(im)
    a=eo(lt/0.6); sc=0.7+0.3*eob(lt/0.8)+0.015*math.sin(t*2.5)
    lh=logo_at(im,W/2,H*0.45,W*(0.56 if V else 0.34),a,sc,claro=dark)
    L=Image.new('RGBA',(W,H))
    f=F(OSW,int((104 if V else 92)*u),700); ft=C['preroll'].get('titulo') or '¿Sabías que?'
    a1=eo((lt-0.15)/0.5); ya=H*0.45-lh/2-int((150 if V else 130)*u)+(1-a1)*(-30*u)
    txt(L,((W-d.textlength(ft,font=f))/2,ya),ft,f,(120,175,255) if dark else RED,a1)
    a2=eo((lt-0.35)/0.5); dy=(1-a2)*40*u; y0=H*0.45+lh/2+44*u+dy
    fk=F(OSW,int((84 if V else 76)*u),700); tip=C['preroll'].get('tipologia') or ''
    if tip: txt(L,((W-d.textlength(tip,font=fk))/2,y0),tip,fk,(255,255,255) if dark else INK,a2)
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
    import glob; return len(glob.glob('broll/f*.png'))
def broll(i):
    global BROLL
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
def bfr(t):
    n=broll_n()
    if n<=1: return kenburns(broll(0),((t-E0)/(T-POST-E0)))
    return broll(int((t-E0)*FPS)%n)
def vertical_src():
    return broll_n()>0 and broll(0).height>broll(0).width
def cover(fr,W,H):
    s=max(W/fr.width,H/fr.height); fr=fr.resize((int(fr.width*s)+1,int(fr.height*s)+1),Image.LANCZOS)
    x0=(fr.width-W)//2; y0=(fr.height-H)//2; return fr.crop((x0,y0,x0+W,y0+H))
def grad(W,H,y0,y1,a0,a1):
    g=np.linspace(a0,a1,max(1,y1-y0),dtype=np.float32)[:,None].repeat(W,1)
    m=Image.new('L',(W,H),0); m.paste(Image.fromarray(np.clip(g,0,255).astype(np.uint8)),(0,y0)); return m
# v5.4: sin pastilla ni texto. Pista sutil dentro del vídeo: icono pequeño de reproducir con un leve
# resplandor que respira, en la esquina superior derecha del vídeo. La interactividad la da el modal del Stock.
def play_hint(im,x1,y1,u,a,t):
    if a<=0: return
    from PIL import ImageFilter
    r=int(26*u); g=int(r*2.6); cx,cy=x1-g//2,y1+g//2; pulse=0.55+0.25*(0.5+0.5*math.sin(t*2.4))
    G_=Image.new('RGBA',(g,g)); ImageDraw.Draw(G_).ellipse([g/2-r*1.05,g/2-r*1.05,g/2+r*1.05,g/2+r*1.05],fill=(255,255,255,int(150*a*pulse)))
    G_=G_.filter(ImageFilter.GaussianBlur(r*0.45)); im.alpha_composite(G_,(cx-g//2,cy-g//2))
    D=ImageDraw.Draw(im); D.ellipse([cx-r,cy-r,cx+r,cy+r],fill=(15,15,20,int(110*a)),outline=(255,255,255,int(220*a)),width=max(2,int(2.5*u)))
    k=r*0.42; D.polygon([(cx-k*0.75,cy-k),(cx-k*0.75,cy+k),(cx+k*1.05,cy)],fill=(255,255,255,int(235*a)))
def headline(L,d,t,x,y,tw,V,u,col,maxl):
    cf=C['gancho'].get('cifra') or {}
    if cf.get('hasta'):
        p=eo((t-2)/2.4); val=cf.get('desde',0)+(cf['hasta']-cf.get('desde',0))*p
        n=int(round(val/10))*10 if cf['hasta']>=1000 else (round(val,1) if cf['hasta']!=int(cf['hasta']) else int(round(val)))
        fc=F(ANTON,int((220 if V else 220)*u),700)
        txt(L,(x,y),fmt(n) if isinstance(n,int) else str(n).replace('.',','),fc,col,eo((t-2)/0.3))
        if cf.get('unidad'): txt(L,(x+int(8*u),y+int(260*u)),cf['unidad'],F(OSW,int(64*u),700),RED if col==INK else (120,175,255),eo((t-2.3)/0.5))
        return y+int(350*u)
    fh=F(OSW,int((84 if V else 80)*u),700); ls=wrap(d,C['preroll']['subtitulo'] or G['objeto'],fh,tw)[:maxl]
    for i,s_ in enumerate(ls): txt(L,(x,y+i*int(96*u)),s_,fh,col,eo((t-2-i*0.12)/0.4))
    return y+len(ls)*int(96*u)
def lines(L,d,t,x,y,tw,u,cols3,size):
    items=[(C[k]['linea'],*C[k]['linea_t']) for k in ('gancho','giro','remate')]
    cols={items[0][0]:cols3[0],items[1][0]:cols3[1],items[2][0]:cols3[2]}; fl=F(INTER,int(size*u),700)
    for s_,al,dx in secuencia(t,items):
        for i,l in enumerate(wrap(d,s_,fl,tw)): txt(L,(x-dx*u,y+i*int(size*1.28*u)),l,fl,cols[s_],al)
def explain(t,W,H):
    V=H>W; u=min(W,H)/1080; mx=int(80*u); br=C['giro'].get('broll') or {}; fsrc=C['remate']['fuente']
    a=eo((t-E0)/0.4); vs=vertical_src() if broll_n() else False
    if V and vs:
        # 9x16 + fuente vertical: vídeo a pantalla completa, franjas legibles.
        im=cover(bfr(t),W,H).convert('RGBA'); sh=Image.new('RGBA',(W,H),(8,8,12,255))
        m=Image.fromarray(np.maximum(np.array(grad(W,H,0,int(H*0.20),220,0)),np.maximum(np.array(grad(W,H,int(H*0.46),int(H*0.60),0,225)),np.array(grad(W,H,int(H*0.60),H,225,235))))); im.alpha_composite(Image.composite(sh,Image.new('RGBA',(W,H)),m))
        d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
        txt(L,(mx,int(50*u)),C['titulo'],F(OSW,int(72*u),700),(120,175,255),1); logo_at(im,W-mx-int(110*u),int(95*u),int(220*u),1,claro=True)
        play_hint(im,W-mx,int(H*0.20),u,a,t)
        y=headline(L,d,t,mx,int(H*0.60),W-2*mx,V,u,(255,255,255),2)
        lines(L,d,t,mx,max(y+int(30*u),int(H*0.75)),W-2*mx,u,((255,255,255),(140,190,255),(255,255,255)),60)
        im.alpha_composite(L); return im
    im=background(t,W,H,'explain'); d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
    txt(L,(mx,int(50*u)),C['titulo'],F(OSW,int(72*u),700),RED,1)
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
    u=min(W,H)/1080; V=H>W
    if t<2: im=brand_card(0,t,W,H,V,u)
    elif t>=T-POST: im=brand_card(T-POST,t,W,H,V,u,out=True)
    else: im=explain(t,W,H)
    barra_progreso(im,min(t,T-POST) if t<T-POST else T,T,RED,u,abajo=True)  # en el cierre fijo, barra llena y quieta
    return im
STILLS=(1,5,7,10,15,17.5)
def render(W,H,out):
    p=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
       '-f','lavfi','-i',f'anullsrc=r=48000:cl=stereo:d={T}',
       '-map','0:v','-map','1:a','-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-preset','medium','-c:a','aac','-b:a','128k','-t',str(T),'-movflags','+faststart',out],stdin=subprocess.PIPE)
    for i in range(FPS*T):
        t=i/FPS; im=frame(t,W,H).convert('RGB'); p.stdin.write(im.tobytes())
        pass
    p.stdin.close(); p.wait()
    for s in STILLS: frame(s,W,H).convert('RGB').save(out.replace('.mp4',f'-t{s:g}s.png'))  # stills en el instante exacto
if __name__=='__main__':
    render(1920,1080,'capsula-16x9.mp4'); render(1080,1920,'capsula-9x16.mp4')
