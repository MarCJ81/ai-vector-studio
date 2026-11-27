/* ============================================================
   원탭 벡터 스튜디오 · precision.js  (V2 · VTracer 네이티브)
   ------------------------------------------------------------
   엔진: visioncortex/vtracer 1.0.0-alpha.4 WebAssembly
   (GitHub ★7.6k · MIT OR Apache-2.0 · github.com/visioncortex/vtracer)
   바이너리는 engine/ 안에 base64 로 인라인돼 있어 외부 요청이 0.

   V1 은 색을 16색 팔레트로 깎은 뒤 팔레트에 스냅해서 추적했다.
   그래서 복잡한 일러스트·UI 스크린샷의 그라데이션과 작은 글씨가
   뭉개졌다. V2 는 두 갈래로 나눈다.

   · native  — VTracer 의 풀컬러 클러스터링을 그대로 쓴다.
               색 정밀도(2~8) · 색 단계(그라데이션 병합) · 잡음 제거.
               일러스트·사진·UI 스크린샷·흑백 스캔·픽셀아트.
   · palette — V1 이 잘하던 평면 로고 경로. Median-Cut+K-means 로
               팔레트를 뽑고 픽셀을 스냅해 AA 잡색을 없앤 뒤 VTracer 로
               윤곽만 딴다. 작은 로고·워드마크가 가장 깔끔하다.

   두 갈래 모두 결과는 같은 레이어 모델 → SVG / EPS / PDF·AI 내보내기.

   공통 파이프라인
     1) 작업 해상도로 축소(기본 1200px)
     2) 배경 투명화(가장자리/모서리 플러드필) — 선택
     3) 잡음 제거(가우시안) — JPEG 잡티·색 번짐 제거
     4) 투명부를 배경색으로 합성
     5) 작은 이미지는 슈퍼샘플(2~8×) — 팔레트/흑백 모드
     6) VTracer 추적 → 배경 패스 제거 · 안쪽 배경은 evenodd 구멍
     7) 레이어 모델

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

  /** 배경색과 사실상 같은(±6) 레이어 색을 배경색으로 맞춘다 — 배경 제거가 먹히도록 */
  function snapNearBase(layers, base) {
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var dr = L.color[0] - base[0], dg = L.color[1] - base[1], db = L.color[2] - base[2];
      if (dr * dr + dg * dg + db * db <= 36) {
        L.color = [base[0], base[1], base[2]];
        L.hex = hexOf(base);
      }
    }
    return layers;
  }

  /* ── 공통 준비 ─────────────────────────────────────── */
  function prepare(input, o) {
    var maxSide = o.maxSide || 1200;
    var fitted = C.fitImage(input, maxSide);
    var work = { width: fitted.width, height: fitted.height, data: new Uint8ClampedArray(fitted.data) };
    var bgOpt = o.background || { mode: 'edges', tolerance: 30 };
    var bgRes = bgOpt.mode === 'none'
      ? { removed: 0, bgColor: null }
      : C.removeBackground(work, bgOpt);
    var clustering = o.clustering === 'bw' ? 'bw' : 'color';
    var base = (bgRes.bgColor && clustering !== 'bw')
      ? [Math.round(bgRes.bgColor[0]), Math.round(bgRes.bgColor[1]), Math.round(bgRes.bgColor[2])]
      : [255, 255, 255];
    var denoise = o.denoise == null ? 0 : clamp(Number(o.denoise) || 0, 0, 4);
    if (denoise > 0) work = C.denoiseRGBA(work, denoise, 12);
    var hasAlpha = false, n = work.width * work.height;
    for (var i = 0; i < n; i++) if (work.data[i * 4 + 3] < 250) { hasAlpha = true; break; }
    return {
      fitted: fitted, work: work, bgRes: bgRes, bgOpt: bgOpt,
      clustering: clustering, base: base, denoise: denoise, hasAlpha: hasAlpha, maxSide: maxSide
    };
  }

  function pickSupersample(o, p) {
    if (o.supersample == null || o.supersample === 'auto') {
      return C.autoSupersample(p.fitted.width, p.fitted.height, p.maxSide);
    }
    return clamp(Math.round(Number(o.supersample) || 1), 1, 8);
  }

  /**
   * 잡음 많은 이미지 판별 — 5bit 양자화 색이 600가지를 넘으면 JPEG 잡티·노이즈로 본다.
   * 이때는 잡티 필터를 최소 1로 올려야 SVG 가 수 MB로 폭발하지 않는다.
   */
  function isNoisy(image) {
    var n = image.width * image.height, d = image.data;
    var step = Math.max(1, Math.floor(n / 60000));
    var seen = {}, uniq = 0;
    for (var i = 0; i < n; i += step) {
      var o = i * 4;
      if (d[o + 3] < 8) continue;
      var key = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
      if (seen[key]) continue;
      seen[key] = 1;
      if (++uniq > 600) return true;
    }
    return false;
  }

  /** SVG → 레이어(좌표 1/ss) + 배경 접기 */
  function finish(svg, p, ss, digits, ctx) {
    var upW = Math.round(p.fitted.width * (ss || 1));
    var upH = Math.round(p.fitted.height * (ss || 1));
    var parsed = C.parseTraceSVG(svg, {});
    if (p.hasAlpha && p.clustering !== 'bw' && p.bgRes.removed > 0) parsed = snapNearBase(parsed, ctx.base);
    var folded = (p.hasAlpha && p.clustering !== 'bw')
      ? C.foldBackground(parsed, hexOf(ctx.base), upW, upH)
      : { layers: parsed, dropped: 0 };

    var outLayers = [], anchors = 0, loopsCount = 0, uniq = {};
    var canvasArea = p.fitted.width * p.fitted.height;
    for (var l = 0; l < folded.layers.length; l++) {
      var L = folded.layers[l];
      var areaSrc = L.area / (ss * ss);
      if (areaSrc < (ctx.minArea == null ? 0.35 : ctx.minArea) && !L.holes) continue;
      if (ctx.dropTiny && areaSrc < canvasArea * 0.00002 && L.loops.length >= 4 && !L.holes) continue;
      var d = C.loopsToD(L.loops, 1 / ss, digits);
      if (!d) continue;
      var color = [L.color[0], L.color[1], L.color[2]];
      var hex = C.rgbToHex(color);
      outLayers.push({
        color: color, hex: hex, d: d,
        area: areaSrc, loopCount: L.loops.length, anchors: L.anchors
      });
      anchors += L.anchors;
      loopsCount += L.loops.length;
      uniq[hex] = 1;
    }
    var svgBytes = 0;
    for (var g = 0; g < outLayers.length; g++) svgBytes += outLayers[g].d.length + 40;
    return { layers: outLayers, anchors: anchors, loops: loopsCount, used: Object.keys(uniq).length,
             dropped: folded.dropped, svgBytes: svgBytes };
  }

  function result(p, o, extra, t0, raw) {
    var digits = extra.digits;
    return {
      version: C.version,
      engine: 'vtracer',
      strategy: extra.strategy,
      engineVersion: S.api.version ? S.api.version() : '',
      width: p.fitted.width,
      height: p.fitted.height,
      sourceWidth: extra.sourceWidth,
      sourceHeight: extra.sourceHeight,
      scale: p.fitted.scale,
      supersample: extra.ss,
      native: extra.native || null,
      layers: extra.layers,
      stats: {
        ms: Math.round(now() - t0),
        colors: extra.used,
        usedColors: extra.used,
        layerCount: extra.layers.length,
        loops: extra.loops,
        anchors: extra.anchors,
        rawPoints: raw,
        reduction: raw > 0 ? clamp(1 - extra.anchors / raw, 0, 0.999) : 0,
        svgBytes: extra.svgBytes,
        removedBackground: p.bgRes.removed,
        removedSpecks: extra.removedSpecks || 0,
        speckPixels: extra.speckPixels || 0,
        droppedBackground: extra.dropped,
        simplify: o.simplify == null ? 0 : Number(o.simplify),
        denoise: p.denoise,
        speckle: extra.speckleUsed == null ? (o.speckle == null ? 0 : Number(o.speckle)) : extra.speckleUsed,
        autoNoise: !!extra.autoNoise,
        maxColors: extra.maxColors || 0,
        colorPrecision: extra.colorPrecision || 0,
        layerDifference: extra.layerDifference || 0,
        mode: extra.mode || 'spline',
        hierarchical: extra.hierarchical || 'stacked',
        clustering: p.clustering,
        digits: digits,
        supersample: extra.ss,
        traceBytes: extra.traceBytes || 0
      }
    };
  }

  /* ══ native: VTracer 풀컬러 ══════════════════════════ */
  function traceNative(input, o, t0) {
    var p = prepare(input, o);
    var digits = o.digits == null ? 2 : clamp(o.digits | 0, 0, 3);
    var ss = pickSupersample(o, p);
    if (o.mode === 'pixel') ss = Math.max(1, Math.min(ss, 2));

    var flat = C.flatten(p.work, p.base);
    var up = ss > 1 ? C.resample(flat, ss) : flat;
    var noisy = p.clustering === 'color' && isNoisy(flat);
    var speckle = Math.max(0, o.speckle == null ? 0 : Number(o.speckle));
    if (noisy && speckle < 1) speckle = 1;             // 잡음 많은 이미지는 자동으로 1px

    // 배경을 지운 경우(투명도 필요)에는 'cutout' — 겹치지 않는 면으로 나눠야
    // 배경 패스를 지워도 아래층 색이 새어 나오지 않는다. 아니면 VTracer 기본 'stacked'.
    var hier = o.hierarchical === 'stacked' || o.hierarchical === 'cutout'
      ? o.hierarchical
      : (p.bgRes.removed > 0 ? 'cutout' : 'stacked');
    var traceOpts = {
      mode: o.mode === 'polygon' || o.mode === 'pixel' ? o.mode : 'spline',
      hierarchical: hier,
      colorPrecision: clamp(Math.round(o.colorPrecision == null ? 8 : Number(o.colorPrecision)), 1, 8),
      layerDifference: Math.max(0, Math.round(o.layerDifference == null ? 0 : Number(o.layerDifference))),
      filterSpeckle: Math.max(0, Math.round(speckle * ss * ss)),
      cornerThreshold: clamp(Math.round(o.cornerThreshold == null ? 60 : Number(o.cornerThreshold)), 0, 180),
      lengthThreshold: Math.max(0.5, (o.lengthThreshold == null ? 1.6 : Number(o.lengthThreshold)) * ss),
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: digits,
      simplify: Math.max(0, (o.simplify == null ? 0 : Number(o.simplify)) * ss),
      optimize: 2
    };
    if (o.maxColors > 0) traceOpts.maxColors = Math.min(2048, Math.round(o.maxColors));
    if (p.clustering === 'bw') {
      traceOpts.clustering = 'bw';
      traceOpts.adaptive = o.adaptive !== false;
      if (!traceOpts.adaptive) {
        traceOpts.binaryThreshold = clamp(Math.round(o.binaryThreshold == null ? 128 : Number(o.binaryThreshold)), 1, 254);
      }
      traceOpts.colorPrecision = 8;
    }

    var svg = S.api.vectorizeRGBA(up.data, up.width, up.height, traceOpts);
    var f = finish(svg, p, ss, digits, {
      base: flat.base, minArea: o.minLayerArea == null ? 0.35 : o.minLayerArea, dropTiny: true
    });
    var raw = boundaryPoints(flat);

    return result(p, o, {
      digits: digits, strategy: 'native', ss: ss, native: traceOpts,
      layers: f.layers, anchors: f.anchors, loops: f.loops, used: f.used, dropped: f.dropped,
      svgBytes: f.svgBytes, maxColors: traceOpts.maxColors || 0, autoNoise: noisy, speckleUsed: speckle,
      colorPrecision: traceOpts.colorPrecision, layerDifference: traceOpts.layerDifference,
      mode: traceOpts.mode, hierarchical: traceOpts.hierarchical, traceBytes: svg.length,
      sourceWidth: input.width, sourceHeight: input.height
    }, t0, raw);
  }

  /* ══ palette: 평면 로고 ══════════════════════════════ */
  function tracePalette(input, o, t0) {
    var p = prepare(input, o);
    var digits = o.digits == null ? 2 : clamp(o.digits | 0, 0, 3);
    var colorCount = clamp(Math.round(o.colors || o.maxColors || 6), 2, 64);

    var q = C.quantize(p.work, colorCount, {
      skipEdge: p.bgRes.removed > 0,
      palette: o.palette,
      maxSamples: o.maxSamples,
      kmeansIterations: o.kmeansIterations
    });
    var palette = q.palette.map(function (c) { return [c[0], c[1], c[2]]; });

    var w = p.fitted.width, h = p.fitted.height, n = w * h;
    // 잡티(px²) 흡수 — 팔레트 라벨에서 직접 지운다
    var minArea = Math.max(0, Number(o.speckle == null ? 1 : o.speckle) * 2);
    var before = q.labels.slice();
    var specks = C.removeSpecks(q.labels, w, h, minArea, palette.length);
    var pre = { width: w, height: h, data: new Uint8ClampedArray(p.work.data) };
    if (specks.removed) {
      for (var i = 0; i < n; i++) {
        if (q.labels[i] === before[i]) continue;
        var lab = q.labels[i], po = i * 4;
        if (lab >= 0) {
          pre.data[po] = palette[lab][0]; pre.data[po + 1] = palette[lab][1]; pre.data[po + 2] = palette[lab][2];
        }
      }
    }

    var ss = pickSupersample(o, p);
    var up = ss > 1 ? C.resample(pre, ss) : pre;
    var flat = C.flattenToPalette(up, palette, p.base);

    var hierP = o.hierarchical === 'stacked' || o.hierarchical === 'cutout'
      ? o.hierarchical
      : (p.bgRes.removed > 0 ? 'cutout' : 'stacked');
    var traceOpts = {
      mode: 'spline',
      hierarchical: hierP,
      cornerThreshold: clamp(Math.round(o.cornerThreshold == null ? 60 : Number(o.cornerThreshold)), 0, 180),
      filterSpeckle: 0,
      lengthThreshold: Math.max(1.2, (o.lengthThreshold == null ? 1.6 : Number(o.lengthThreshold)) * ss),
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: digits,
      optimize: 2,
      colorPrecision: 8,
      simplify: Math.max(0, (o.simplify == null ? 0.5 : Number(o.simplify)) * ss)
    };

    var svg = S.api.vectorizeRGBA(flat.data, flat.width, flat.height, traceOpts);
    var f = finish(svg, p, ss, digits, {
      base: flat.base, minArea: Math.max(0.6, minArea * 0.5), dropTiny: true
    });
    var raw = boundaryPoints(flat);

    return result(p, o, {
      digits: digits, strategy: 'palette', ss: ss, native: traceOpts,
      layers: f.layers, anchors: f.anchors, loops: f.loops, used: f.used, dropped: f.dropped,
      svgBytes: f.svgBytes, maxColors: colorCount, colorPrecision: 8, layerDifference: 0,
      mode: 'spline', hierarchical: traceOpts.hierarchical, traceBytes: svg.length,
      removedSpecks: specks.removed, speckPixels: specks.pixels,
      sourceWidth: input.width, sourceHeight: input.height
    }, t0, raw);
  }

  /* ── 공개 API ──────────────────────────────────────── */
  function vectorize(input, options) {
    var o = options || {};
    var t0 = now();
    if (!input || !input.width || !input.height || !input.data) throw new Error('image required');
    if (o.strategy === 'palette') return tracePalette(input, o, t0);
    return traceNative(input, o, t0);
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
