"""Local-only renderer verification. Never contacts or publishes to Stock.

CAPSULE_FONT_DIR must contain the same three bundled variable fonts.
CAPSULE_RENDER_TEST_OUT optionally retains example frames and videos.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / 'tools/capsulas-sabiasque'
sys.path.insert(0, str(TOOLS))
from text_positions import normalize_positions, shifted_xy, SCHEMA
from capsula_cola import guion_v5
from PIL import Image, ImageChops


class TextPositionsTest(unittest.TestCase):
    def test_validation_and_coordinate_contract(self):
        layout = {'horizontal': {'heading': {'x': -.1, 'y': .05}},
                  'vertical': {'heading': {'x': .1, 'y': -.05}}}
        self.assertEqual(normalize_positions(layout), layout)
        self.assertEqual(shifted_xy(layout, 'heading', 1920, 1080, 400, 300), (208, 354))
        self.assertEqual(shifted_xy(layout, 'heading', 1080, 1920, 400, 300), (508, 204))
        for bad in [[], True, {'square': {}}, {'vertical': {'heading': {'x': 2, 'y': 0}}},
                    {'horizontal': {'gancho': {'x': True, 'y': 0}}},
                    {'horizontal': {'heading': {'x': float('nan'), 'y': 0}}},
                    {'horizontal': {'heading': {'x': 0, 'y': 0, 'fade': 1}}}]:
            with self.assertRaises(ValueError):
                normalize_positions(bad)

    def test_queue_and_actual_frames(self):
        if not os.environ.get('CAPSULE_FONT_DIR'):
            self.skipTest('Set CAPSULE_FONT_DIR to the bundled capsule fonts')
        job = {'ref': 'capsula-url:0000000000000001', 'source': {'url': 'https://example.test/', 'kind': 'articulo'},
               'guion': {'objeto': 'ENSAYO', 'subtitulo': 'ENSAYO', 'tema': 'creatividad',
                         'gancho': 'GANCHO', 'giro': 'GIRO', 'remate': 'REMATE',
                         'fuente': 'Fuente: ENSAYO', 'cifra': {'hasta': None, 'unidad': ''}},
               'cartelas': {'preroll': True, 'postroll': True},
               'textPositions': {'horizontal': {'heading': {'x': -.02, 'y': .03}},
                                 'vertical': {'remate': {'x': .01, 'y': -.02}}}}
        script = guion_v5(job)
        self.assertEqual(script['textPositions'], job['textPositions'])
        self.assertEqual(script['textPositionSchema'], SCHEMA)
        self.assertNotIn('textPositions', script['capsulas'][0]['gancho'])
        base = Path(os.environ.get('CAPSULE_RENDER_TEST_OUT') or tempfile.mkdtemp(prefix='capsule-position-test-'))
        base.mkdir(parents=True, exist_ok=True)
        before_cwd = Path.cwd()
        try:
            # Cover portrait source / band layout, landscape source and no source.
            for source_name, source_size in [('portrait', (180, 320)), ('landscape', (320, 180)), ('none', None)]:
                folder = base / source_name
                folder.mkdir(exist_ok=True)
                (folder / 'broll').mkdir(exist_ok=True)
                if source_size:
                    Image.new('RGB', source_size, (40, 65, 95)).save(folder / 'broll/f000.png')
                shutil.copy(TOOLS / 'logo.png', folder / 'logo.png')
                (folder / 'guion.json').write_text(json.dumps(script), encoding='utf-8')
                os.chdir(folder)
                spec = importlib.util.spec_from_file_location('render_position_' + source_name, TOOLS / 'render_url.py')
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                original_txt = module.txt
                calls = []
                def traced(layer, xy, text, font, color, alpha):
                    if alpha > 0:
                        calls.append((text, xy))
                    return original_txt(layer, xy, text, font, color, alpha)
                module.txt = traced
                for width, height in [(1920, 1080), (1080, 1920)]:
                    orientation = 'vertical' if height > width else 'horizontal'
                    opposite = 'horizontal' if height > width else 'vertical'
                    # Every movable box, including distinct equal-looking phase text.
                    for time, text, key in [(4, 'ENSAYO', 'heading'), (4, 'GANCHO', 'gancho'),
                                            (7, 'GIRO', 'giro'), (12, 'REMATE', 'remate'),
                                            (7, '¿Sabías que?', 'marca'), (17, 'Vídeo original: ENSAYO', 'fuente'),
                                            (17, 'Connecting things to Internet', 'claim')]:
                        module.TEXT_POSITIONS = {}
                        calls.clear()
                        before = module.frame(time, width, height)
                        baseline = next(xy for value, xy in calls if value == text)
                        module.TEXT_POSITIONS = {orientation: {key: {'x': -.02, 'y': .03}},
                                                 opposite: {key: {'x': .4, 'y': -.4}}}
                        calls.clear()
                        after = module.frame(time, width, height)
                        moved = next(xy for value, xy in calls if value == text)
                        self.assertAlmostEqual(moved[0] - baseline[0], -.02 * width, places=5)
                        self.assertAlmostEqual(moved[1] - baseline[1], .03 * height, places=5)
                        self.assertIsNotNone(ImageChops.difference(before.convert('RGB'), after.convert('RGB')).getbbox())
                        if source_name == 'portrait' and key == 'heading':
                            before.save(folder / f'{orientation}-before.png')
                            after.save(folder / f'{orientation}-after.png')
                    # Equal copy in different phases still has distinct positions.
                    old_lines = {key: module.C[key]['linea'] for key in ('gancho', 'giro', 'remate')}
                    for key in old_lines:
                        module.C[key]['linea'] = 'MISMO'
                    for time, key in [(4, 'gancho'), (7, 'giro'), (12, 'remate')]:
                        module.TEXT_POSITIONS = {}
                        calls.clear(); module.frame(time, width, height)
                        baseline = next(xy for value, xy in calls if value == 'MISMO')
                        module.TEXT_POSITIONS = {orientation: {key: {'x': .015, 'y': -.025}}}
                        calls.clear(); module.frame(time, width, height)
                        moved = next(xy for value, xy in calls if value == 'MISMO')
                        self.assertAlmostEqual(moved[0] - baseline[0], .015 * width, places=5)
                        self.assertAlmostEqual(moved[1] - baseline[1], -.025 * height, places=5)
                    for key, value in old_lines.items():
                        module.C[key]['linea'] = value
                    # Figure heading and unit are separate boxes, as in the editor.
                    module.C['gancho']['cifra'] = {'desde': 0, 'hasta': 42, 'unidad': 'UNIDAD'}
                    for key, text in [('heading', '42'), ('unidad', 'UNIDAD')]:
                        module.TEXT_POSITIONS = {}
                        calls.clear(); module.frame(6, width, height)
                        baseline = next(xy for value, xy in calls if value == text)
                        module.TEXT_POSITIONS = {orientation: {key: {'x': .01, 'y': -.02}}}
                        calls.clear(); module.frame(6, width, height)
                        moved = next(xy for value, xy in calls if value == text)
                        self.assertAlmostEqual(moved[0] - baseline[0], .01 * width, places=5)
                        self.assertAlmostEqual(moved[1] - baseline[1], -.02 * height, places=5)
                    module.C['gancho']['cifra'] = None
                if source_name == 'portrait' and os.environ.get('CAPSULE_RENDER_TEST_VIDEO') == '1':
                    module.txt = original_txt
                    module.TEXT_POSITIONS = copy.deepcopy(script['textPositions'])
                    module.PRE_ON = False; module.POST_ON = False; module.OFF = 2
                    module.POST = 0; module.FPS = 4; module.T = 3; module.STILLS = ()
                    module.render(1920, 1080, 'position-test-16x9.mp4')
                    module.render(1080, 1920, 'position-test-9x16.mp4')
        finally:
            os.chdir(before_cwd)


if __name__ == '__main__':
    unittest.main()
