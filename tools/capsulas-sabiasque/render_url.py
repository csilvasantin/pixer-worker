"""render_url.py — render v5 de una cápsula «¿Sabías que?» encargada desde el Creador (URL).
Es render_v2.py (Taalas) generalizado: cifra opcional (si no hay, titular grande), unidad del guion,
b-roll opcional (vídeo de la fuente o su miniatura) y crédito del guion. Misma plantilla_v5.
Uso: cd <carpeta con guion.json, logo.png y broll/> && python3 render_url.py"""
import json, math, subprocess, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plantilla_v5 import PRE, CIERRE_S, T_TOTAL_V51, barra_progreso, secuencia, fit_line, linea_fuente
import numpy as np
from PIL import Image, ImageDraw, ImageFont
G=json.load(open('guion.json',encoding='utf-8')); C=G['capsulas'][0]
FPS=25; T=T_TOTAL_V51; POST=CIERRE_S   # v5.1: 2 + 12 + 4 (cierre fijo)
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
def logo_at(im,cx,cy,lw,a,scale=1):
    lw=max(2,int(lw*scale)); lg=LOGO.resize((lw,int(LOGO.height*lw/LOGO.width)),Image.LANCZOS)
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
        im.alpha_composite(L); return im
    # v5.1: «¿Sabías que?» ENCIMA del logo; la tipología (categoría de la cápsula) DEBAJO.
    im=background(t,W,H,'brand'); d=ImageDraw.Draw(im); lt=t-t0
    a=eo(lt/0.6); sc=0.7+0.3*eob(lt/0.8)+0.015*math.sin(t*2.5)
    lh=logo_at(im,W/2,H*0.45,W*(0.56 if V else 0.34),a,sc)
    L=Image.new('RGBA',(W,H))
    f=F(OSW,int((104 if V else 92)*u),700); ft=C['preroll'].get('titulo') or '¿Sabías que?'
    a1=eo((lt-0.15)/0.5); ya=H*0.45-lh/2-int((150 if V else 130)*u)+(1-a1)*(-30*u)
    txt(L,((W-d.textlength(ft,font=f))/2,ya),ft,f,RED,a1)
    a2=eo((lt-0.35)/0.5); dy=(1-a2)*40*u; y0=H*0.45+lh/2+44*u+dy
    fk=F(OSW,int((84 if V else 76)*u),700); tip=C['preroll'].get('tipologia') or ''
    if tip: txt(L,((W-d.textlength(tip,font=fk))/2,y0),tip,fk,INK,a2)
    f2=F(INTER,int(42*u),600); s2=C['preroll'].get('subtitulo') or ''; a3=eo((lt-0.6)/0.5)
    if s2: txt(L,((W-d.textlength(s2,font=f2))/2,y0+(110 if tip else 0)*u+(1-a3)*30*u),s2,f2,GREY,a3)
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
def explain(t,W,H):
    V=H>W; u=min(W,H)/1080
    im=background(t,W,H,'explain'); d=ImageDraw.Draw(im); L=Image.new('RGBA',(W,H))
    mx=int(80*u); fl_=lambda ph,amp=6: amp*u*math.sin(t*1.8+ph)
    txt(L,(mx,int(50*u)+fl_(0,3)),C['titulo'],F(OSW,int(72*u),700),RED,1)
    logo_at(im,W-mx-int(110*u),int(95*u),int(220*u),1)
    cf=C['gancho'].get('cifra') or {}
    cy=int(H*(0.12 if V else 0.20))+fl_(1)
    if cf.get('hasta'):
        p=eo((t-2)/2.4); val=cf.get('desde',0)+(cf['hasta']-cf.get('desde',0))*p
        n=int(round(val/10))*10 if cf['hasta']>=1000 else (round(val,1) if cf['hasta']!=int(cf['hasta']) else int(round(val)))
        fc=F(ANTON,int((300 if V else 280)*u*(1+0.02*math.sin(t*2.2))),700)
        txt(L,(mx,cy),fmt(n) if isinstance(n,int) else str(n).replace('.',','),fc,INK,eo((t-2)/0.3))
        if cf.get('unidad'):
            fu=F(OSW,int((84 if V else 72)*u),700); txt(L,(mx+int(8*u),cy+int((345 if V else 330)*u)),cf['unidad'],fu,RED,eo((t-2.3)/0.5))
    else:
        tw0=(W-2*mx) if V else int(W*0.44); fh=F(OSW,int((112 if V else 96)*u),700)
        for i,s in enumerate(wrap(d,C['preroll']['subtitulo'] or G['objeto'],fh,tw0)[:3 if V else 4]):
            txt(L,(mx,cy+int(20*u)+i*int((128 if V else 110)*u)),s,fh,INK,eo((t-2-i*0.12)/0.4))
    br=C['giro'].get('broll') or {}; b0,b1=br.get('t_capsula',[5.05,9.05])
    if broll_n() and b0-0.4<=t<b1+0.4:
        a=min(eo((t-b0+0.4)/0.4),1-max(0,min(1,(t-b1)/0.4)))
        fr=broll(int((t-b0)*FPS)) if broll_n()>1 else kenburns(broll(0),(t-b0)/(b1-b0))
        bw=W-2*mx if V else int(W*0.42); bh=int(bw*fr.height/fr.width)
        mh=int(H*(0.30 if V else 0.50))
        if bh>mh: bw=int(bw*mh/bh); bh=mh
        bx=mx if V else int(W*0.52); by=int(H*0.375) if V else int(H*0.17)
        by+=int((1-a)*40*u)
        fr=fr.resize((bw,bh),Image.LANCZOS); m=Image.new('L',(bw,bh),0)
        ImageDraw.Draw(m).rounded_rectangle([0,0,bw-1,bh-1],radius=int(20*u),fill=int(255*a)); fr.putalpha(m)
        im.alpha_composite(fr,(bx,by))
        # v5.1: crédito visible + llamada a tocar (en el Stock el tramo del b-roll abre la fuente).
        txt(L,(bx,by+bh+int(12*u)),br.get('credito',''),F(INTER,int(34*u),700),INK,a)
        hint=br.get('indicacion') or 'Toca para ver el original'
        fh_=F(INTER,int(30*u),600); hw=d.textlength(hint,font=fh_); hx,hy=bx+bw-int(hw)-int(28*u),by+bh-int(66*u)
        tri=int(22*u); hx+=tri+int(6*u)
        ImageDraw.Draw(L).rounded_rectangle([hx-tri-int(22*u),hy-int(10*u),hx+int(hw)+int(16*u),hy+int(46*u)],radius=int(26*u),fill=(20,20,24,int(200*a)))
        ImageDraw.Draw(L).polygon([(hx-tri-int(6*u),hy+int(6*u)),(hx-tri-int(6*u),hy+int(30*u)),(hx-int(8*u),hy+int(18*u))],fill=(255,255,255,int(255*a)))
        txt(L,(hx,hy),hint,fh_,(255,255,255),a)
    items=[(C[k]['linea'],*C[k]['linea_t']) for k in ('gancho','giro','remate')]
    cols={items[0][0]:INK,items[1][0]:RED,items[2][0]:INK}
    fl=F(INTER,int((64 if V else 60)*u),700); tw=W-2*mx
    y0=int(H*(0.72 if V else 0.74))
    for s,al,dx in secuencia(t,items):
        for i,l in enumerate(wrap(d,s,fl,tw)):
            txt(L,(mx-dx*u,y0+i*int(80*u)+fl_(2,4)),l,fl,cols[s],al)
    fs=F(INTER,int(32*u),500); fsrc=C['remate']['fuente']
    linea_fuente(L,fsrc['texto'],fs,mx,H-int(90*u),GREY,eo((t-fsrc['t'][0])/0.5))
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
