/* ============================================================
   원탭 벡터 스튜디오 · precision.js
   ------------------------------------------------------------
   '정밀 로고' 엔진.

   1) 팔레트는 우리 엔진(core.js)이 뽑는다 — 작은 강조색 구출,
      AA 혼합색 정리까지 이미 검증된 부분.
   2) 투명 픽셀은 배경색으로 합성한 뒤 모든 픽셀을 팔레트에 스냅한다
      → AA 그라데이션이 사라져 색 띠가 생기지 않는다.
   3) 작은 이미지(≤480px)는 자동 2×~8× Lanczos 슈퍼샘플링 —
      획 폭 4px짜리 글자도 서브픽셀 곡선으로 되살린다.
   4) 윤곽·곡선은 VTracer(WASM)가 그린다 — GitHub 최고 평판
      (★7.5k, MIT OR Apache-2.0) 벡터화 엔진. 브라우저 안에서만
      돌고 바이너리는 이 사이트에 인라인돼 있다(외부 요청 0).
   5) 배경 패스는 버리고, 도형 안쪽 배경 패스는 구멍(evenodd)으로
      접어 넣는다 → 'd'의 닫힌 공간이 투명하게 남는다.
   6) 결과는 core.js 와 같은 레이어 모델이라 EPS·PDF·AI 내보내기가
      그대로 동작한다.

   VTracer 가 없거나 실패하면 자체 엔진(core.vectorize)으로 폴백한다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), null);
  else root.PrecisionVector = factory(root.VectorCore, root);
})(typeof self !== 'undefined' ? self : this, function (C, root) {
  'use strict';

  var S = { status: 'idle', api: null, error: null, promise: null };
  if (!root) root = typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : {});
  var ENGINE_FILE = 'engine/vtracer-engine.js';
  var DATA_FILE = 'engine/vtracer-data.js';

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function hexOf(rgb) { return C.rgbToHex(rgb); }

  /* ── 엔진 로딩 ─────────────────────────────────────── */
  function injectScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadInBrowser() {
    if (S.promise) return S.promise;
    S.status = 'loading';
    S.promise = injectScript(DATA_FILE)
      .then(function () { return injectScript(ENGINE_FILE); })
      .then(function () {
        var api = root.VtracerWasm;
        if (!api) throw new Error('VtracerWasm missing');
        api.init(root.__VTRACER_WASM_B64);
        S.api = api;
        S.status = 'ready';
        return api;
      })
      .catch(function (err) {
        S.status = 'failed';
        S.error = String((err && err.message) || err);
        return null;
      });
    return S.promise;
  }

  function loadNode() {
    if (S.api) return Promise.resolve(S.api);
    try {
      var api = require('./engine/vtracer-engine.js');
      var b64 = require('./engine/vtracer-data.js');
      api.init(b64);
      S.api = api;
      S.status = 'ready';
    } catch (e) {
      S.status = 'failed';
      S.error = String((e && e.message) || e);
    }
    return Promise.resolve(S.api || null);
  }

  function load() {
    if (S.status === 'ready' || S.status === 'failed') return Promise.resolve(S.api || null);
    return typeof document === 'undefined' ? loadNode() : loadInBrowser();
  }
  function ready() { return !!S.api && S.api.ready(); }

  /* ── 원본 윤곽 점 개수(감소율 표시용) ───────────────── */
  function boundaryPoints(image) {
    var w = image.width, h = image.height, d = image.data, n = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        if (x + 1 < w) {
          var o2 = o + 4;
          if (d[o] !== d[o2] || d[o + 1] !== d[o2 + 1] || d[o + 2] !== d[o2 + 2]) n++;
        }
        if (y + 1 < h) {
          var o3 = o + w * 4;
          if (d[o] !== d[o3] || d[o + 1] !== d[o3 + 1] || d[o + 2] !== d[o3 + 2]) n++;
        }
      }
    }
    return n;
  }

  /* ── 정밀 변환 ─────────────────────────────────────── */
  function vectorize(input, options) {
    var o = options || {};
    var t0 = now();
    if (!input || !input.width || !input.height || !input.data) throw new Error('image required');
    var maxSide = o.maxSide || 1200;

    var fitted = C.fitImage(input, maxSide);
    var work = { width: fitted.width, height: fitted.height, data: new Uint8ClampedArray(fitted.data) };
    var bgOpt = o.background || { mode: 'edges', tolerance: 30 };
    var bgRes = C.removeBackground(work, bgOpt);
    var q = C.quantize(work, o.colors == null ? 6 : o.colors, {
      skipEdge: bgRes.removed > 0,
      palette: o.palette,
      maxSamples: o.maxSamples,
      kmeansIterations: o.kmeansIterations
    });
    var palette = q.palette.map(function (p) { return [p[0], p[1], p[2]]; });

    // 투명 픽셀이 있으면 그 자리를 무엇으로 채워 추적할지 정한다.
    //  · 지운 배경색이 있으면 그 색 (AA 테두리가 실제로 그 색과 섞인 값이므로)
    //  · 없으면 흰색
    var hasAlpha = false, n = fitted.width * fitted.height;
    for (var i = 0; i < n; i++) if (fitted.data[i * 4 + 3] < 8) { hasAlpha = true; break; }
    var base = bgRes.bgColor
      ? [Math.round(bgRes.bgColor[0]), Math.round(bgRes.bgColor[1]), Math.round(bgRes.bgColor[2])]
      : [255, 255, 255];

    // 잡티는 원본 해상도에서 지운다 — 8× 로 키운 뒤 지우면 획 조각까지
    // 지워지기 때문에(면적 기준이 ×64 가 된다) 여기서 정확히 처리한다.
    //  · 라벨을 복사해 두고, 흡수된 픽셀만 주변색으로 바꿔 AA 경계는 살린다.
    var before = q.labels.slice();
    var specks = C.removeSpecks(q.labels, fitted.width, fitted.height,
      o.minArea == null ? 1 : o.minArea, palette.length);
    var pre = { width: fitted.width, height: fitted.height, data: new Uint8ClampedArray(fitted.data) };
    if (specks.removed) {
      for (var p = 0; p < n; p++) {
        if (q.labels[p] === before[p]) continue;
        var lab = q.labels[p], po = p * 4;
        if (lab >= 0) {
          pre.data[po] = palette[lab][0]; pre.data[po + 1] = palette[lab][1]; pre.data[po + 2] = palette[lab][2];
        }
      }
    }

    var ss = o.supersample == null || o.supersample === 'auto'
      ? C.autoSupersample(fitted.width, fitted.height, maxSide)
      : clamp(Math.round(Number(o.supersample) || 1), 1, 8);
    var up = ss > 1 ? C.resample(pre, ss) : pre;
    var flat = C.flattenToPalette(up, palette, base);

    var traceOpts = {
      mode: 'spline',
      hierarchical: 'stacked',
      cornerThreshold: o.cornerAngle == null ? 60 : o.cornerAngle,
      filterSpeckle: 0,
      lengthThreshold: Math.max(1.2, (o.lengthThreshold == null ? 1.6 : o.lengthThreshold) * ss),
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: 3,
      optimize: 2,
      colorPrecision: 8,
      simplify: Math.max(0, (o.simplify == null ? 0.25 : o.simplify) * ss),
      palette: flat.palette.map(hexOf)
    };

    var svg = S.api.vectorizeRGBA(flat.data, flat.width, flat.height, traceOpts);
    var digits = o.digits == null ? 2 : clamp(o.digits | 0, 0, 3);
    var parsed = C.parseTraceSVG(svg, {});
    var folded = hasAlpha ? C.foldBackground(parsed, hexOf(flat.base), flat.width, flat.height)
      : { layers: parsed, dropped: 0 };

    var outLayers = [], anchors = 0, loopsCount = 0;
    var minLayerArea = Math.max(0.6, (o.minArea == null ? 1 : o.minArea) * 0.5);
    var canvasArea = fitted.width * fitted.height;
    for (var l = 0; l < folded.layers.length; l++) {
      var L = folded.layers[l];
      // AA 티끌 패스 버리기: 아주 작으면서 조각이 많은 패스는 노이즈다
      var areaSrc = L.area / (ss * ss);
      if (areaSrc < minLayerArea && !L.holes) continue;
      if (areaSrc < canvasArea * 0.0015 && L.loops.length >= 3) continue;
      var d = C.loopsToD(L.loops, 1 / ss, digits);
      if (!d) continue;
      var color = [L.color[0], L.color[1], L.color[2]];
      outLayers.push({
        color: color,
        hex: C.rgbToHex(color),
        d: d,
        area: L.area / (ss * ss),
        loopCount: L.loops.length,
        anchors: L.anchors
      });
      anchors += L.anchors;
      loopsCount += L.loops.length;
    }

    // ── 복잡도 가드 ─────────────────────────────────
    // VTracer 가 드물게 영역을 잘게 쪼개 수십 개의 조각으로 내보낸다
    // (같은 그림을 자체 엔진은 1/4 용량으로 매끈하게 뽑는 경우).
    // 그럴 때는 자체 엔진 결과가 더 좋으므로 호출부가 고를 수 있게 표시한다.
    var tiny = 0;
    for (var t = 0; t < outLayers.length; t++) if (outLayers[t].anchors <= 3) tiny++;
    var pathological = outLayers.length > palette.length * 6 + 12 && anchors > 6 * Math.max(1, outLayers.length);

    var raw = boundaryPoints(flat);
    var svgBytes = 0;
    for (var g = 0; g < outLayers.length; g++) svgBytes += outLayers[g].d.length + 40;

    // 복잡도 가드: 조각이 비정상적으로 많으면(용량 10배 이상) 자체 엔진이 낫다.
    if (pathological && o.noFallback !== true) {
      var core = C.vectorize(input, {
        colors: o.colors, background: bgOpt, minArea: o.minArea, simplify: o.simplify,
        cornerAngle: o.cornerAngle, digits: o.digits, maxSide: maxSide, supersample: 'auto',
        palette: o.palette
      });
      core.engine = 'core';
      core.fallback = 'vtracer-complex';
      core.supersample = core.stats.supersample || core.supersample;
      return core;
    }

    return {
      version: C.version,
      engine: 'vtracer',
      pathological: pathological,
      tinyPaths: tiny,
      engineVersion: S.api.version ? S.api.version() : '',
      width: fitted.width,
      height: fitted.height,
      sourceWidth: input.width,
      sourceHeight: input.height,
      scale: fitted.scale,
      supersample: ss,
      palette: palette.map(function (p) { return { rgb: p.map(Math.round), hex: C.rgbToHex(p) }; }),
      layers: outLayers,
      stats: {
        ms: Math.round(now() - t0),
        colors: palette.length,
        usedColors: (function () { var u = {}; for (var i2 = 0; i2 < outLayers.length; i2++) u[outLayers[i2].hex] = 1; return Object.keys(u).length; })(),
        layerCount: outLayers.length,
        loops: loopsCount,
        anchors: anchors,
        rawPoints: raw,
        reduction: raw > 0 ? clamp(1 - anchors / raw, 0, 0.999) : 0,
        svgBytes: svgBytes,
        mse: q.mse,
        removedBackground: bgRes.removed,
        removedSpecks: specks.removed,
        speckPixels: specks.pixels,
        droppedBackground: folded.dropped,
        simplify: o.simplify == null ? 0.25 : o.simplify,
        digits: digits,
        supersample: ss,
        traceBytes: svg.length
      }
    };
  }

  return {
    load: load,
    ready: ready,
    vectorize: vectorize,
    get status() { return S.status; },
    get error() { return S.error; },
    get version() { return S.api && S.api.version ? S.api.version() : ''; },
    ENGINE_FILE: ENGINE_FILE,
    DATA_FILE: DATA_FILE
  };
});
