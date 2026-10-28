"""Publish the clean b-roll track for browser text editing, separately from final Stock assets."""
import json, os, subprocess, urllib.request, urllib.parse

def publish_preview(job, out, api, headers):
    frames = os.path.join(out, 'broll')
    first = os.path.join(frames, 'f001.png')
    if not os.path.exists(first):
        print('  editor: sin b-roll limpio; no se anuncia vista editable')
        return
    dims=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',first],text=True))['streams'][0]
    aspect=dims['width']/dims['height']
    target = os.path.join(out, 'editor-source.mp4')
    subprocess.run(['ffmpeg','-v','error','-y','-stream_loop','-1','-framerate','25','-i',os.path.join(frames,'f%03d.png'),'-t','12','-an','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-crf','20','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',target],check=True)
    query = urllib.parse.urlencode({'ref':job['ref'],'version':job.get('capsuleVersion',1)})
    with open(target,'rb') as media:
        request = urllib.request.Request(api+'/capsula/url/preview?'+query,data=media.read(),method='PUT',headers={**headers,'Content-Type':'video/mp4','X-Capsule-Aspect':str(aspect)})
    with urllib.request.urlopen(request,timeout=180) as response:
        result=json.load(response)
    if not result.get('ok'):
        raise RuntimeError('editor preview upload failed')
    print('  editor: pista limpia publicada para versión',job.get('capsuleVersion',1))

    return result
