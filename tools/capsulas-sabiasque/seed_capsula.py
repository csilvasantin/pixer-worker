#!/usr/bin/env python3
"""Convert a preserved guion.json into an editable Stock capsula/1 document."""
import argparse
import json
from urllib.parse import urlparse
from capsula_document import from_guion

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('guion')
    parser.add_argument('--parent-id', required=True)
    parser.add_argument('--version', type=int, default=8)
    parser.add_argument('--output', required=True)
    parser.add_argument('--media-url', required=True, help='URL HTTPS del vídeo fuente, sin textos de la cápsula')
    parser.add_argument('--credit', help='Crédito del vídeo; por defecto se recupera del guion')
    args = parser.parse_args()
    with open(args.guion, encoding='utf-8') as fh:
        capsule = from_guion(json.load(fh), args.parent_id, args.version)
    url = urlparse(args.media_url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password:
        parser.error('--media-url debe ser una URL HTTPS sin credenciales')
    source = capsule.pop('sourceMedia', {})
    credit = args.credit or source.get('credito')
    if not credit or not credit.strip():
        parser.error('el guion no tiene crédito de vídeo; indica --credit')
    capsule['media'] = [{'id': 'fuente-original', 'tipo': 'video', 'role': 'background',
                         'src': args.media_url, 'credito': credit.strip(),
                         't': [0, capsule['tiempos']['remate'][1]],
                         'recorte': {'x': 0, 'y': 0, 'w': 1, 'h': 1}}]
    with open(args.output, 'w', encoding='utf-8') as fh:
        json.dump(capsule, fh, ensure_ascii=False, indent=2)
    print(args.output)

if __name__ == '__main__':
    main()
