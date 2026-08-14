import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');

test('signage/now conserva sólo grupos y campos de telemetría explícitos',()=>{
  assert.match(source,/function sanitizeDeviceTelemetry\(raw\)/);
  for(const group of ['display','system','hardware','software','storage','network']) assert.match(source,new RegExp(`${group}: \\{`));
  assert.match(source,/slice\(0, type === 'long' \? 300 : 80\)/);
});

test('GET signage/now expone device y standby',()=>{
  assert.match(source,/device: \(stored && stored\.device\) \|\| null/);
  assert.match(source,/standby: !!\(stored && stored\.standby\)/);
});

test('un cambio de dispositivo rompe el dedupe sin gastar escrituras en cada latido',()=>{
  assert.match(source,/const deviceSig = JSON\.stringify\(device \|\| null\)/);
  assert.match(source,/prev\.__deviceSig === deviceSig/);
  assert.match(source,/__deviceSig: deviceSig/);
});

test('el censo conserva dispositivo y versión sin escribir en cada variación técnica',()=>{
  assert.match(source,/prev\.version !== data\.version/);
  assert.match(source,/machine: machine \|\| \(prev && prev\.machine\) \|\| '',\s+device,/);
  assert.doesNotMatch(source,/prev\.showing_id !== data\.showing_id \|\| prev\.version/);
  assert.doesNotMatch(source,/prev\.version !== data\.version \|\|\s+JSON\.stringify\(prev\.device/);
});
