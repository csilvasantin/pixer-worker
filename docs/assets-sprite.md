# Assets sprite contract / Contrato sprite

Schema `admira.sprite/1`: normalized optional `sprite` beside root `fp`/`ph`. PNG base64 publication validates dimensions and independently binds SHA-256 before writing. Source master RGBA hash is provenance only. Duplicate metadata enrichment requires identical verified bytes and matching placement; conflicting metadata returns 409 without changing identity. A new binary without a valid descriptor clears stale geometry. Buy carries canonical metadata without a second debit for existing ownership; update preserves omitted descriptors and rejects geometry mismatch. KV failure returns 503.

ES: El descriptor opcional conserva las cuatro caras, su orden, apoyo, recorte y proporción original. Huella/altura e IDs se mantienen; la publicación es explícita. No se modifica la generación de pago ni hay endpoint nuevo. Pruebas de Stock/monedero en memoria; sin escrituras reales para validar.
