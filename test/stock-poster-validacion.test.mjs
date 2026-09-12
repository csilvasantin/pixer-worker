import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DURACION_MIN, NEGRO_MAX_RATIO, POSTER_MAX_BYTES,
  elegirPoster, esNegra, evaluarMuestras, parsePoster, posterKeyFromMeta, posterUrl, sanitizeValidacion,
} from '../src/stock-poster.mjs';

// Yokup #3199 (12-sep-2026): el previo del «Langostino cocido» salía NEGRO en
// admira.tv/contentcatalogue. El máster solo tenía negro el fotograma 0 (luma 20)
// y el <video preload=metadata src="…#t=0.1"> pintaba ese fotograma. Estas son
// las reglas puras de decisión: qué máster se rechaza y qué fotograma es póster.

const jpegB64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]).toString('base64');

test('parsePoster: data URL JPEG → bytes; base64 a pelo se asume JPEG; webp aceptado', () => {
  const a = parsePoster(`data:image/jpeg;base64,${jpegB64}`);
  assert.equal(a.error, undefined);
  assert.equal(a.mime, 'image/jpeg'); assert.equal(a.ext, 'jpg'); assert.equal(a.bytes.length, 604);
  const b = parsePoster(jpegB64);
  assert.equal(b.mime, 'image/jpeg');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(600, 2)]).toString('base64');
  assert.equal(parsePoster(`data:image/webp;base64,${webp}`).ext, 'webp');
});

test('parsePoster: rechaza vacío, mime raro, base64 roto, demasiado pequeño/grande y JPEG sin cabecera', () => {
  assert.equal(parsePoster('').error, 'missing-poster');
  assert.equal(parsePoster(null).error, 'missing-poster');
  assert.equal(parsePoster(`data:image/png;base64,${jpegB64}`).error, 'bad-poster-mime');
  assert.equal(parsePoster('data:image/jpeg,abc').error, 'bad-poster-data-url');
  assert.equal(parsePoster(Buffer.alloc(10, 1).toString('base64')).error, 'poster-too-small');
  assert.equal(parsePoster(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(POSTER_MAX_BYTES, 1)]).toString('base64')).error, 'poster-too-big');
  assert.equal(parsePoster(Buffer.alloc(600, 7).toString('base64')).error, 'poster-not-jpeg');
});

test('posterKeyFromMeta reconoce solo pósters propios del mismo id', () => {
  assert.equal(posterKeyFromMeta({ id: 'a-1', thumbnail: 'https://stock.admira.store/stock/a-1/poster.jpg?v=603' }), 'stock/a-1/poster.jpg');
  assert.equal(posterKeyFromMeta({ id: 'a-1', thumbnail: 'https://stock.admira.store/stock/otro/poster.jpg' }), null);
  assert.equal(posterKeyFromMeta({ id: 'a-1', thumbnail: 'data:image/jpeg;base64,xxx' }), null);
  assert.equal(posterKeyFromMeta({ id: 'a-1' }), null);
  assert.equal(posterUrl('https://api.admira.store', 'a-1'), 'https://api.admira.store/stock/poster/a-1');
});

test('sanitizeValidacion: sanea números y textos; un ko sin motivo lleva «sin-motivo»', () => {
  const v = sanitizeValidacion({ ok: 'sí', negros: '9', muestras: 12.4, duracion: 15.123456, motivo: 'x'.repeat(300), por: 'ffmpeg', at: '2026-09-12T10:00:00.000Z' });
  assert.equal(v.ok, false); assert.equal(v.negros, 9); assert.equal(v.muestras, 12.4); assert.equal(v.duracion, 15.12);
  assert.equal(v.motivo.length, 200); assert.equal(v.por, 'ffmpeg'); assert.equal(v.at, '2026-09-12T10:00:00.000Z');
  assert.equal(sanitizeValidacion({ ok: false }).motivo, 'sin-motivo');
  assert.equal(sanitizeValidacion(null), null);
  assert.equal(sanitizeValidacion('ok'), null);
  assert.match(sanitizeValidacion({ ok: true }).at, /^\d{4}-\d{2}-\d{2}T/);
});

// Muestras como las medidas con ffmpeg en el Langostino: fotograma 0 luma 20 y
// después 69…95 con varianza alta.
const langostino = [
  { t: 0.0, luma: 20, var: 4 }, { t: 0.46, luma: 69.7, var: 2400 }, { t: 0.96, luma: 70.8, var: 2500 },
  { t: 1.46, luma: 72.8, var: 2600 }, { t: 2.46, luma: 79.2, var: 2700 }, { t: 3.46, luma: 87.9, var: 2900 },
  { t: 4.46, luma: 95.1, var: 3300 }, { t: 5.46, luma: 93.7, var: 3100 }, { t: 6.46, luma: 92.7, var: 3000 },
  { t: 8.46, luma: 93.2, var: 2800 }, { t: 10.46, luma: 92.7, var: 2900 }, { t: 12.46, luma: 89.0, var: 2500 },
  { t: 14.46, luma: 89.7, var: 2400 },
];

test('esNegra: luma < 16 es negro; luma 20 con varianza baja también (relleno #020508); con imagen no', () => {
  assert.equal(esNegra({ luma: 10, var: 900 }), true);
  assert.equal(esNegra({ luma: 20, var: 4 }), true);
  assert.equal(esNegra({ luma: 20, var: 400 }), false);
  assert.equal(esNegra({ luma: 69.7, var: 2400 }), false);
  assert.equal(esNegra(null), true);
});

test('evaluarMuestras: el Langostino real es VÁLIDO (1/13 negro); un máster negro entero se rechaza con «N/12 fotogramas negros»', () => {
  const ok = evaluarMuestras(langostino, { duracion: 15 });
  assert.equal(ok.ok, true); assert.equal(ok.negros, 1); assert.equal(ok.muestras, 13); assert.equal(ok.motivo, null);
  const negro = Array.from({ length: 12 }, (_, i) => ({ t: i * 1.25, luma: 20, var: 3 }));
  const ko = evaluarMuestras(negro, { duracion: 15 });
  assert.equal(ko.ok, false);
  assert.equal(ko.motivo, 'Vídeo inválido: 12/12 fotogramas negros');
  // Justo en el umbral: 9/12 = 75 % > 70 % → inválido; 8/12 = 66 % → válido.
  const mixto = (n) => negro.slice(0, n).concat(Array.from({ length: 12 - n }, (_, i) => ({ t: 5 + i, luma: 80, var: 2000 })));
  assert.equal(evaluarMuestras(mixto(9), { duracion: 15 }).ok, false);
  assert.equal(evaluarMuestras(mixto(8), { duracion: 15 }).ok, true);
  assert.equal(NEGRO_MAX_RATIO, 0.7);
});

test('evaluarMuestras: duración < 10 s o sin pista de vídeo → inválido', () => {
  assert.equal(DURACION_MIN, 10);
  const corto = evaluarMuestras(langostino, { duracion: 4.2 });
  assert.equal(corto.ok, false); assert.match(corto.motivo, /duración 4\.2 s < 10 s/);
  assert.equal(evaluarMuestras([], { duracion: 15 }).motivo, 'sin pista de vídeo');
  assert.equal(evaluarMuestras(langostino, { duracion: 15, tienePista: false }).ok, false);
  assert.equal(evaluarMuestras(langostino, { duracion: null }).ok, true, 'sin duración conocida (webm sin Duration) no se rechaza por eso');
});

test('elegirPoster: nunca el fotograma 0 negro; máxima varianza con luma 40..220 fuera de los 0,8 s de los extremos', () => {
  const i = elegirPoster(langostino, { duracion: 15 });
  assert.equal(langostino[i].t, 4.46, 'el de mayor varianza dentro del rango');
  assert.notEqual(i, 0);
  // Si todos los candidatos válidos están en los extremos, se admiten igualmente.
  const extremos = [{ t: 0, luma: 20, var: 3 }, { t: 0.3, luma: 90, var: 1000 }, { t: 14.9, luma: 90, var: 1500 }];
  assert.equal(elegirPoster(extremos, { duracion: 15 }), 2);
  // Todo negro → -1 (no hay póster posible).
  assert.equal(elegirPoster([{ t: 1, luma: 5, var: 1 }, { t: 2, luma: 8, var: 2 }]), -1);
  // Fotogramas muy claros (>220) se evitan si hay alternativa; si no, se usan.
  assert.equal(elegirPoster([{ t: 2, luma: 240, var: 5000 }, { t: 5, luma: 120, var: 800 }], { duracion: 15 }), 1);
  assert.equal(elegirPoster([{ t: 2, luma: 240, var: 5000 }], { duracion: 15 }), 0);
});
