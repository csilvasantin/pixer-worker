#!/usr/bin/env python3
"""Sube un MP4 a YouTube (videos.insert, subida reanudable) con /home/box/.secrets/yt_client.json + yt_token.json.
    python3 subir_youtube.py <mp4> <meta.json>   (meta: {title, description, tags, categoryId, privacyStatus})
Nunca imprime secretos. Imprime JSON {id, url}."""
import json, os, sys, urllib.parse, urllib.request
S='/home/box/.secrets'
def token():
    c=json.load(open(f'{S}/yt_client.json')); c=c.get('web') or c.get('installed') or c
    t=json.load(open(f'{S}/yt_token.json'))
    body=urllib.parse.urlencode({'client_id':c['client_id'],'client_secret':c['client_secret'],'refresh_token':t['refresh_token'],'grant_type':'refresh_token'}).encode()
    with urllib.request.urlopen(urllib.request.Request(c.get('token_uri','https://oauth2.googleapis.com/token'),data=body),timeout=60) as r: return json.load(r)['access_token']
def main():
    mp4,meta=sys.argv[1],json.load(open(sys.argv[2])); at=token(); size=os.path.getsize(mp4)
    res={'snippet':{k:meta[k] for k in ('title','description','tags','categoryId') if k in meta},
         'status':{'privacyStatus':meta.get('privacyStatus','private'),'selfDeclaredMadeForKids':False}}
    req=urllib.request.Request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        data=json.dumps(res).encode(),method='POST',headers={'Authorization':'Bearer '+at,'Content-Type':'application/json; charset=UTF-8',
        'X-Upload-Content-Type':'video/mp4','X-Upload-Content-Length':str(size)})
    with urllib.request.urlopen(req,timeout=60) as r: loc=r.headers['Location']
    with open(mp4,'rb') as f:
        up=urllib.request.Request(loc,data=f.read(),method='PUT',headers={'Authorization':'Bearer '+at,'Content-Type':'video/mp4'})
    with urllib.request.urlopen(up,timeout=600) as r: d=json.load(r)
    print(json.dumps({'id':d['id'],'url':'https://youtu.be/'+d['id'],'privacyStatus':d.get('status',{}).get('privacyStatus'),'madeForKids':d.get('status',{}).get('selfDeclaredMadeForKids')}))
if __name__=='__main__': main()
