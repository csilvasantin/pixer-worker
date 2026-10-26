import importlib.util, json, os, subprocess, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('editor_preview',Path(__file__).parents[1]/'tools/capsulas-sabiasque/editor_preview.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PreviewTest(unittest.TestCase):
 def test_clean_track_export_and_authenticated_upload(self):
  with tempfile.TemporaryDirectory() as path:
   os.mkdir(path+'/broll')
   subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=green:s=160x284:r=25:d=0.08',path+'/broll/f%03d.png'],check=True)
   captured=[]
   class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return b'{"ok":true}'
   def upload(request,timeout):captured.append(request);return Response()
   with patch.object(module.urllib.request,'urlopen',upload):
    module.publish_preview({'ref':'capsula-url:aa519cf8a50173ad','capsuleVersion':8},path,'https://api.example',{'Origin':'https://www.admira.studio','X-Notify-Key':'test-only'})
   self.assertEqual(len(captured),1)
   request=captured[0];self.assertEqual(request.method,'PUT');self.assertIn('version=8',request.full_url);self.assertEqual(request.data[4:8],b'ftyp');self.assertEqual(request.headers['X-notify-key'],'test-only')
   duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',path+'/editor-source.mp4'],text=True));self.assertEqual(duration,12)
 def test_missing_track_never_claims_preview_or_uploads(self):
  with tempfile.TemporaryDirectory() as path,patch.object(module.urllib.request,'urlopen') as upload:
   module.publish_preview({'ref':'capsula-url:aa519cf8a50173ad'},path,'https://api.example',{})
   upload.assert_not_called()
if __name__=='__main__':unittest.main()
