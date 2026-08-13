import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeScreenCacheContents, screenCacheSignature } from '../src/index.js';

test('el progreso remoto cambia la firma en tramos del 5 %', () => {
  const ready = ['a'];
  assert.equal(
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 3 }]),
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 4 }]),
    'el ruido dentro del mismo tramo no consume otra escritura',
  );
  assert.notEqual(
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 4 }]),
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 5 }]),
    'al cruzar un tramo el mando recibe un avance nuevo',
  );
  assert.notEqual(
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 45 }]),
    screenCacheSignature(ready, 2, [{ id: 'b', pct: 95 }]),
  );
});

test('dos contenidos distintos no comparten firma aunque haya una sola descarga', () => {
  assert.notEqual(
    screenCacheSignature([], 1, [{ id: 'pieza-a', pct: 20 }]),
    screenCacheSignature([], 1, [{ id: 'pieza-b', pct: 20 }]),
  );
});

test('el inventario técnico cambia la firma y queda acotado por contrato', () => {
  const first=sanitizeScreenCacheContents([{id:'pieza-a',title:'Vídeo',width:1920,height:1080,bitrate:4000000,codec:'H.264',unknown:'fuera'}]);
  assert.deepEqual(first[0],{id:'pieza-a',num:'',title:'Vídeo',type:'',mime:'',bytes:0,width:1920,height:1080,duration:0,bitrate:4000000,codec:'H.264',at:0});
  assert.notEqual(screenCacheSignature(['pieza-a'],1,[],first),screenCacheSignature(['pieza-a'],1,[],[{...first[0],bitrate:6000000}]));
});
