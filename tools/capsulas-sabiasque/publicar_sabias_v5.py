#!/usr/bin/env python3
"""Reconstrucción (22-oct-2026) de tools/publicar_sabias.py adaptada a la plantilla v5 (15 s, barra de progreso + menos texto).
    python3 publicar_sabias_v5.py <carpeta> [--ref-sufijo -v3] [--publicar] [-v] [-h] [--formatos vertical,horizontal]
    -v / -h (o --formatos) limitan la publicación a esa orientación; sin ellos se usan los formatos del guion (v5.8).
Sin --publicar solo hace ensayo. NO envía «comment»: la tarjeta del Stock lo pintaba como bloque 💬 duplicado (Carlos, 22-oct-2026). POST {API}/stock/publish con origin www.pixeria.com, igual que el original."""
import base64, json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plantilla_v5 import ORIENT, formatos_de
API = os.environ.get("STOCK_API", "https://api.admira.store")
INDICE = os.environ.get("STOCK_INDEX", "https://pub-bf043a4daa3b43b7a0b769617729d074.r2.dev/stock/index.json")
MOTOR = "AdmiraNeXT · cápsula «¿Sabías que?» (Python + ffmpeg, plantilla v5, audio en silencio)"
UA = {"user-agent": "Mozilla/5.0 admiranext-capsulas"}
def payload(g, fichero, orient, ref):
    with open(fichero, "rb") as fh: b64 = base64.b64encode(fh.read()).decode()
    loc = g.get("locucion") or {}
    return {"type": "video", "motor": MOTOR, "mime": "video/mp4", "base64": b64,
        "title": f"¿Sabías que? · {g['objeto']}",
        "prompt": " ".join(loc.get(k, "") for k in ("gancho", "cifra", "idea"))[:1000],
        "tags": (g["capsulas"][0].get("tags") or ["capsula", "sabiasque"]) + [orient],
        "quality": "best", "externalRef": ref}
def main():
    carpeta = sys.argv[1]; real = "--publicar" in sys.argv
    suf = sys.argv[sys.argv.index("--ref-sufijo") + 1] if "--ref-sufijo" in sys.argv else ""
    g = json.load(open(os.path.join(carpeta, "guion.json"), encoding="utf-8"))
    hp = os.path.join(carpeta, "publicados.json"); hechos = json.load(open(hp)) if os.path.exists(hp) else {}
    ref = f"sabias-que:{g['fecha']}:{g['tipo']}{suf}"
    with urllib.request.urlopen(urllib.request.Request(INDICE, headers=UA), timeout=60) as r:
        ya = [x for x in json.load(r)["items"] if x.get("type") == "video" and x.get("externalRef") == ref]
    pedidos = [o for f, o in (("-v", "vertical"), ("-h", "horizontal")) if f in sys.argv]
    if "--formatos" in sys.argv: pedidos += formatos_de(sys.argv[sys.argv.index("--formatos") + 1])
    formatos = formatos_de(pedidos or (g.get("capsulas") or [{}])[0].get("formatos"), g.get("orientacion"))
    for orient in formatos:
        f = os.path.join(carpeta, ORIENT[orient][2])
        if orient in hechos: print(f"{orient}: ya publicado → {hechos[orient]['id']}"); continue
        prev = [x for x in ya if orient in (x.get("tags") or [])]
        if prev: print(f"{orient}: ya está en el Stock → {prev[0]['id']}"); continue
        p = payload(g, f, orient, ref)
        if not real: print(f"[ensayo] {orient}:", json.dumps({k: v for k, v in p.items() if k != "base64"}, ensure_ascii=False)); continue
        req = urllib.request.Request(f"{API}/stock/publish", data=json.dumps(p).encode(), method="POST",
              headers={"content-type": "application/json", "origin": "https://www.pixeria.com", **UA})
        with urllib.request.urlopen(req, timeout=300) as r: d = json.load(r)
        if not d.get("ok"): sys.exit(f"{orient}: rechazado: {d}")
        hechos[orient] = {"id": d["id"], "url": d["url"], "createdAt": d.get("createdAt"), "resp": d}
        json.dump(hechos, open(hp, "w"), indent=1, ensure_ascii=False); print(f"{orient}: publicado → {d['id']} {d['url']}")
if __name__ == "__main__": main()
