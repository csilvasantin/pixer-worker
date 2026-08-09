import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("Pixeria publica cápsulas y conserva guion sólo como tipo histórico", () => {
  assert.match(source, /'capsula', 'guion'/);
  assert.match(source, /const isKnowledgeCapsule = type === 'capsula' \|\| type === 'guion'/);
  assert.match(source, /if \(isKnowledgeCapsule && !base64 && !sourceUrl\)/);
  assert.match(source, /capsula-sin-texto/);
});

test("la cápsula conserva la referencia y la miniatura de su vídeo", () => {
  assert.match(source, /isKnowledgeCapsule && !thumbnail && typeof body\.externalRef/);
  assert.match(source, /externalRef: externalId \? id : \(typeof body\.externalRef/);
  assert.match(source, /thumbnail: thumbnail \? String\(thumbnail\).*thumbHeredada/s);
});
