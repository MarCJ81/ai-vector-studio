#!/usr/bin/env node
/* VTracer(wasm-bindgen) 글루를 브라우저/노드 공용으로 바꾸고,
   wasm 바이너리를 base64 데이터 파일로 만든다.
   사용: node tools/build-vtracer.js <@visioncortex/vtracer 패키지 경로> */
'use strict';
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-vtracer.js <pkg dir>'); process.exit(1); }
const pkg = path.resolve(src);
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
let glue = fs.readFileSync(path.join(pkg, 'pkg', 'vtracer_wasm.js'), 'utf8');

// 1) `exports.x = x;` 제거 (브라우저에는 exports 가 없다)
glue = glue.replace(/^exports\.(\w+) = \w+;\s*$/gm, '');

// 2) node 전용 로더 꼬리를 init() 으로 교체
const tail = /const wasmPath[\s\S]*?wasm\.__wbindgen_start\(\);\s*$/;
if (!tail.test(glue)) { console.error('unexpected glue tail'); process.exit(1); }
glue = glue.replace(tail, `let wasm = null;
let wasmInstance = null;
function initWasm(input) {
  if (wasm) return true;
  let bytes = input;
  if (typeof bytes === 'string') bytes = b64ToBytes(bytes);
  if (!bytes || !bytes.length) throw new Error('wasm bytes required');
  const mod = new WebAssembly.Module(bytes);
  wasmInstance = new WebAssembly.Instance(mod, __wbg_get_imports());
  wasm = wasmInstance.exports;
  if (wasm.__wbindgen_start) wasm.__wbindgen_start();
  return true;
}
function isReady() { return !!wasm; }
function b64ToBytes(b64) {
  b64 = String(b64).replace(/\\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function version() { return ${JSON.stringify(pkgJson.version)}; }
`);

const out = `/*! VTracer ${pkgJson.version} — WebAssembly build of visioncortex/vtracer.
 *  (c) VisionCortex contributors · MIT OR Apache-2.0
 *  https://github.com/visioncortex/vtracer
 *  이 파일은 npm 패키지 @visioncortex/vtracer 의 wasm-bindgen 글루를
 *  브라우저에서도 쓰도록 로더만 바꾼 것입니다 (알고리즘 코드는 그대로). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VtracerWasm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
${glue}
  return {
    version: version,
    init: initWasm,
    ready: isReady,
    vectorizeRGBA: vectorize_rgba,
    vectorizeBytes: vectorize_bytes
  };
});
`;
fs.writeFileSync(path.join(__dirname, '..', 'engine', 'vtracer-engine.js'), out);

const wasm = fs.readFileSync(path.join(pkg, 'pkg', 'vtracer_wasm_bg.wasm'));
const b64 = wasm.toString('base64');
const data = `/*! VTracer ${pkgJson.version} WebAssembly 바이너리 (base64).
 *  외부 CDN 요청 없이 한 파일로 끝내기 위해 인라인한다.
 *  (c) VisionCortex contributors · MIT OR Apache-2.0
 *  https://github.com/visioncortex/vtracer */
(function (root) {
  var b64 = '${b64}';
  if (typeof module === 'object' && module.exports) module.exports = b64;
  else root.__VTRACER_WASM_B64 = b64;
})(typeof self !== 'undefined' ? self : this);
`;
fs.writeFileSync(path.join(__dirname, '..', 'engine', 'vtracer-data.js'), data);
console.log('engine/vtracer-engine.js', out.length, 'bytes');
console.log('engine/vtracer-data.js', data.length, 'bytes');
