"""Static text-box offsets shared by both output orientations; no animation editing."""
import math

SCHEMA = 'admira.text-positions.v1'
FORMATS = ('horizontal', 'vertical')
BOXES = ('heading', 'gancho', 'giro', 'remate', 'fuente', 'marca', 'unidad', 'claim')

def normalize_positions(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('invalid-text-positions')
    result = {}
    for orientation, boxes in value.items():
        if orientation not in FORMATS or not isinstance(boxes, dict):
            raise ValueError('invalid-text-positions')
        for key, pos in boxes.items():
            if key not in BOXES or not isinstance(pos, dict) or set(pos) != {'x', 'y'}:
                raise ValueError('invalid-text-positions')
            if any(type(pos[k]) not in (int, float) or not math.isfinite(pos[k]) or abs(pos[k]) > 1 for k in ('x', 'y')):
                raise ValueError('invalid-text-positions')
            # Match JavaScript Math.round, including negative half steps.
            x, y = (math.floor(pos[k] * 100000 + .5) / 100000 for k in ('x', 'y'))
            if x or y:
                result.setdefault(orientation, {})[key] = {'x': x, 'y': y}
    return result

def shifted_xy(positions, key, width, height, x, y):
    pos = positions.get('vertical' if height > width else 'horizontal', {}).get(key, {})
    return x + pos.get('x', 0) * width, y + pos.get('y', 0) * height
