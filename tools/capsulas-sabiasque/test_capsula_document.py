import copy
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch
from capsula_document import from_guion, to_guion, validate
from capsula_text import fit_text, wrap_offsets

BASE = os.path.dirname(__file__)

def fixture():
    with open(os.path.join(BASE, 'referencia-taalas-v2', 'guion.json')) as fh:
        return json.load(fh)

class DocumentTests(unittest.TestCase):
    def test_preserves_unknown_guion_fields_without_mutating_seed(self):
        guion = fixture()
        guion['futureMetadata'] = {'preserve': True}
        original = copy.deepcopy(guion)
        document = from_guion(guion, 'stock-original', 8)
        document['textos']['gancho'] = 'Una frase editada'
        document['spans'] = [{'campo': 'gancho', 'ini': 4, 'fin': 9, 'estilo': 'enfasis'}]
        result = to_guion(document)
        self.assertEqual(guion, original)
        self.assertEqual(result['futureMetadata'], {'preserve': True})
        self.assertEqual(result['capsulas'][0]['gancho']['linea'], 'Una frase editada')
        self.assertEqual(result['capsulaEditor']['spans'], document['spans'])
        self.assertEqual(document['version'], 8)
        self.assertEqual(document['nextVersion'], 9)

    def test_output_timing_maps_to_renderer_and_changes_duration(self):
        doc = from_guion(fixture(), 'original', 8)
        doc['cartelas'] = {'preroll': False, 'postroll': False}
        doc['tiempos'] = {'gancho': [0, 2], 'giro': [2, 6.25], 'remate': [6.25, 15.5]}
        result = to_guion(doc)['capsulas'][0]
        self.assertEqual(result['duracion_s'], 15.5)
        self.assertEqual(result['giro']['linea_t'], [4, 8.25])
        self.assertEqual(result['remate']['linea_t'], [8.25, 17.5])
        self.assertEqual(result['giro']['broll']['t_capsula'], [0, 15.5])

    def test_seed_uses_contiguous_beats_and_editable_headline(self):
        seed = fixture()
        seed['capsulas'][0]['gancho']['cifra'] = None
        doc = from_guion(seed, 'original', 8)
        self.assertEqual(doc['tiempos']['gancho'][1], doc['tiempos']['giro'][0])
        self.assertEqual(doc['tiempos']['giro'][1], doc['tiempos']['remate'][0])
        self.assertEqual(doc['textos']['titulo'], seed['capsulas'][0]['preroll']['subtitulo'])
        doc['textos']['titulo'] = 'Un titular revisado'
        result = to_guion(doc)['capsulas'][0]
        self.assertEqual(result['titulo'], '¿Sabías que?')
        self.assertEqual(result['preroll']['subtitulo'], 'Un titular revisado')

    def test_rejects_overlap_invalid_span_and_crop(self):
        doc = from_guion(fixture())
        doc['tiempos'] = {'gancho': [0, 4], 'giro': [3, 6], 'remate': [6, 12]}
        with self.assertRaises(ValueError): validate(doc)
        doc['tiempos']['giro'] = [4, 6]
        doc['spans'] = [{'campo': 'gancho', 'ini': 0, 'fin': 9999, 'estilo': 'enfasis'}]
        with self.assertRaises(ValueError): validate(doc)
        doc['spans'] = []
        doc['media'] = [{'tipo': 'image', 'src': 'image.png', 't': [0, 12], 'credito': 'Autor',
                         'recorte': {'x': .8, 'y': 0, 'w': .5, 'h': 1}}]
        with self.assertRaises(ValueError): validate(doc)

    def test_preview_never_publishes_even_with_real_flag(self):
        import capsula_cola
        with patch.object(capsula_cola, 'get', side_effect=AssertionError('No network')):
            # No path is read and no index is consulted, so superseding cannot happen.
            self.assertEqual(capsula_cola.publicar({'previewOnly': True}, '/does-not-exist', True), {})

    def test_preview_callback_has_job_render_id(self):
        import capsula_cola
        with tempfile.TemporaryDirectory() as directory:
            for stem in ('capsula-9x16', 'capsula-16x9'):
                for suffix in ('.mp4', '-t1s.png', '-t5s.png', '-t10s.png'):
                    with open(os.path.join(directory, stem+suffix), 'wb') as fh: fh.write(b'test')
            sent = []
            def record(path, payload):
                sent.append((path, payload))
                return {'url': 'https://preview.example/'+payload.get('filename', '')}
            with patch.object(capsula_cola, 'post', side_effect=record):
                result = capsula_cola.preview_result({'ref': 'capsula-url:abc', 'capsuleVersion': 9,
                    'renderId': 'render-123'}, directory, upload=True)
            self.assertEqual(len(result['preview']['orientaciones']['vertical']['stills']), 3)
            self.assertTrue(all(payload['renderId'] == 'render-123' for _, payload in sent))
            self.assertEqual(sent[-1][0], '/capsula/url/estado')

    def test_wrapping_never_discards_words(self):
        from PIL import Image, ImageDraw, ImageFont
        draw = ImageDraw.Draw(Image.new('RGB', (640, 640)))
        font_path = next(p for p in ('/System/Library/Fonts/Supplemental/Arial.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf') if os.path.exists(p))
        text = 'Una frase completa con énfasis y palabras largas debe conservarse entera.'
        font, lines, size = fit_text(draw, text, lambda n: ImageFont.truetype(font_path, n), 60, 260, 6)
        self.assertEqual(' '.join(line.strip() for line, _ in lines), text)
        for line, offset in lines:
            self.assertLessEqual(draw.textlength(line.strip(), font=font), 260)
            self.assertTrue(text[offset:].startswith(line.strip()))

    def test_wrapping_keeps_offsets_after_newlines_and_multiple_spaces(self):
        from PIL import Image, ImageDraw, ImageFont
        draw = ImageDraw.Draw(Image.new('RGB', (640, 640)))
        font = ImageFont.load_default(size=18)
        text = 'Primero   énfasis\nDespués cifra y unaPalabraExtraordinariamenteLarga'
        lines = wrap_offsets(draw, text, font, 125)
        self.assertGreater(len(lines), 2)
        for line, offset in lines:
            self.assertEqual(text[offset:offset+len(line)], line)
            self.assertLessEqual(draw.textlength(line, font=font), 125)

    def test_preview_revisions_keep_separate_outputs_and_do_not_mutate_draft(self):
        import capsula_cola
        with tempfile.TemporaryDirectory() as directory:
            doc = from_guion(fixture(), 'original', 8)
            original = copy.deepcopy(doc)
            job = {'ref': 'capsula-url:aa519cf8a50173ad', 'capsula': doc,
                   'capsuleVersion': 9, 'previewOnly': True, 'renderId': 'phase-a'}
            def local_media(task, out, **kw):
                task['capsula']['media'] = [{'tipo': 'image', 'src': 'source.png', 't':[0,12],
                    'credito':'Fuente', 'localFile': 'source.png', 'role': 'background'}]
            with patch.object(capsula_cola, 'prepare_editor_media', side_effect=local_media), \
                 patch.object(capsula_cola, 'broll'), patch.object(capsula_cola.subprocess, 'run'), \
                 patch.object(capsula_cola, 'preview_result', side_effect=lambda task,out,upload: {'out':out}):
                first = capsula_cola.process_job(job, output_root=directory)
                job['renderId'] = 'phase-b'
                second = capsula_cola.process_job(job, output_root=directory)
            self.assertNotEqual(first['out'], second['out'])
            self.assertTrue(os.path.isfile(os.path.join(first['out'], 'guion.json')))
            self.assertTrue(os.path.isfile(os.path.join(second['out'], 'guion.json')))
            self.assertEqual(doc, original)

    def test_real_renderer_applies_media_crop_timing_and_edited_beats(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            old_cwd = os.getcwd()
            try:
                os.chdir(directory)
                Image.new('RGB', (120, 200), (0, 80, 0)).save('base.png')
                overlay = Image.new('RGB', (80, 40), (0, 0, 255))
                overlay.paste((255, 0, 0), (40, 0, 80, 40)); overlay.save('support.png')
                doc = from_guion(fixture(), 'original', 8)
                doc['sourceGuion']['capsulas'][0]['gancho']['cifra'] = None
                doc['cartelas'] = {'preroll': False, 'postroll': False}
                doc['tiempos'] = {'gancho': [0, 2], 'giro': [2, 7], 'remate': [7, 12]}
                doc['textos']['gancho'] = 'Gancho editado'
                doc['textos']['giro'] = 'Giro editado'
                doc['spans'] = [{'campo': 'giro', 'ini': 0, 'fin': 4, 'estilo': 'enfasis'}]
                doc['media'] = [
                    {'id':'base','tipo':'image','src':'base.png','localFile':'base.png',
                     'role':'background','credito':'Fuente de prueba','t':[0,12]},
                    {'id':'support','tipo':'image','src':'support.png','localFile':'support.png',
                     'credito':'Apoyo de prueba','t':[3,6], 'recorte':{'x':.5,'y':0,'w':.5,'h':1}}]
                with open('guion.json', 'w') as fh: json.dump(to_guion(doc), fh)
                shutil.copy(os.path.join(BASE,'logo.png'), 'logo.png')
                spec = importlib.util.spec_from_file_location('test_capsule_renderer', os.path.join(BASE,'render_url.py'))
                renderer = importlib.util.module_from_spec(spec); spec.loader.exec_module(renderer)
                inter_path = os.environ.get('CAPSULA_FONT_INTER')
                if inter_path and os.path.isfile(inter_path):
                    from PIL import ImageFont
                    expected = ImageFont.truetype(inter_path, 30)
                    expected.set_variation_by_axes([14,700])
                    self.assertEqual(renderer.F(renderer.INTER,30,700).getlength('Bill Duke'),
                                     expected.getlength('Bill Duke'))
                # bfr receives classic timeline seconds; no-preroll output adds OFF=2.
                before = renderer.bfr(4)
                during = renderer.bfr(6)
                after = renderer.bfr(9)
                self.assertEqual(before.getpixel((60,90))[:3], (0,80,0))
                self.assertEqual(during.getpixel((60,90))[:3], (255,0,0))
                self.assertEqual(after.getpixel((60,90))[:3], (0,80,0))
                drawn = []
                original_draw = renderer.draw_spans
                def record(*args, **kwargs):
                    drawn.append((args[2],args[7])); return original_draw(*args, **kwargs)
                with patch.object(renderer, 'draw_spans', side_effect=record):
                    frame = renderer.frame(4, 768, 432)
                self.assertEqual(frame.size, (768,432))
                self.assertTrue(any('Giro editado' in text and spans == doc['spans'] for text,spans in drawn))
                self.assertFalse(any('Gancho editado' in text for text,_ in drawn))
            finally:
                os.chdir(old_cwd)

if __name__ == '__main__':
    unittest.main()
