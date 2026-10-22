#!/bin/bash
# Consumidor de la cola «Crear cápsula desde URL» en GrokBotBox (cada 2 min).
cd "$(dirname "$0")"
while true; do echo "== $(date '+%F %T %Z')"; python3 capsula_cola.py --publicar 2>&1 | tail -20; sleep 120; done
