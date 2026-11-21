/* ============================================================
   원탭 벡터 스튜디오 · core.js
   ------------------------------------------------------------
   AI로 만든 래스터 로고/일러스트(PNG·JPG·WebP)를 인쇄용 벡터
   (SVG · EPS · PDF/AI)로 바꾸는 순수 JS 엔진. 의존성 0, 빌드 0.
   브라우저는 window.VectorCore, node 는 require().

   파이프라인
     1) 전처리   배경 플러드필 투명화 → 팔레트 양자화(median-cut
                 + k-means) → 스펙클(minArea) 제거
     2) 윤곽     안티에일리어싱 커버리지 기반 서브픽셀 멤버십 필드
                 → Marching Squares 등고선 → 폐곡선 링크
     3) 정리     Douglas–Peucker 단순화 → 코너 감지 → 3차 베지어
                 최소제곱 피팅(Schneider) → 좌표 반올림 → 색상별 병합
     4) 내보내기 SVG / EPS(PostScript Level 2) / PDF 1.4(=.ai 호환)
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VectorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ==========================================================
     0 · 유틸
     ========================================================== */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function dist2c(a, b) { var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return dr * dr + dg * dg + db * db; }
  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /** 소수점 digits 자리로 반올림한 뒤 0을 털어낸 최소 표기 (SVG/EPS/PDF 공용) */
  function fmt(v, digits) {
    if (!isFinite(v)) return '0';
    var p = Math.pow(10, digits == null ? 2 : digits);
    var n = Math.round(v * p) / p;
    if (n === 0) n = 0;                       // -0 제거
    var s = digits > 0 ? n.toFixed(digits) : String(n);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    return s;
  }

  /** "x y" — 뒤 숫자가 음수면 공백 생략 (SVG/EPS 문법 허용) */
  function pair(x, y, digits) {
    var a = fmt(x, digits), b = fmt(y, digits);
    return b.charAt(0) === '-' ? a + b : a + ' ' + b;
  }

  /* ==========================================================
     1 · 색 계산
     ========================================================== */
  function hexToRgb(hex) {
    var h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(rgb) {
    function p(v) { var s = clamp(Math.round(v), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return ('#' + p(rgb[0]) + p(rgb[1]) + p(rgb[2])).toUpperCase();
  }
  /** 인쇄 안내용 단순 변환(프로파일 기반 아님). K=max 보정 없음(잉크 절약형). */
  function rgbToCmyk(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var k = 1 - Math.max(r, g, b);
    if (k >= 0.999) return [0, 0, 0, 1];
    var d = 1 - k;
    return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
  }
  function lum(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

  /* ==========================================================
     2 · 이미지 준비
     ========================================================== */
  /**
   * 긴 변이 maxSide 를 넘으면 박스 평균으로 축소한다.
   * @returns {{width:number,height:number,data:any,scale:number}}
   */
  function fitImage(image, maxSide) {
    var w = image.width | 0, h = image.height | 0, src = image.data;
    var side = Math.max(w, h);
    if (!maxSide || side <= maxSide) return { width: w, height: h, data: src, scale: 1 };
    var s = maxSide / side;
    var nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    var out = new Uint8ClampedArray(nw * nh * 4);
    var fx = w / nw, fy = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * fy), y1 = Math.min(h, Math.ceil((y + 1) * fy));
      for (var x = 0; x < nw; x++) {
        var x0 = Math.floor(x * fx), x1 = Math.min(w, Math.ceil((x + 1) * fx));
        var r = 0, g = 0, b = 0, a = 0, n = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx < x1; xx++) {
            var o = (row + xx) * 4;
            var al = src[o + 3];
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += al; n++;
          }
        }
        var o2 = (y * nw + x) * 4;
        out[o2] = r / n; out[o2 + 1] = g / n; out[o2 + 2] = b / n; out[o2 + 3] = a / n;
      }
    }
    return { width: nw, height: nh, data: out, scale: nw / w };
  }

  /** 알파 채널만 뽑아 0~1 로 */
  function alphaOf(image) {
    var n = image.width * image.height, src = image.data, a = new Float32Array(n);
    for (var i = 0; i < n; i++) a[i] = src[i * 4 + 3] / 255;
    return a;
  }

  /* ==========================================================
     3 · 팔레트 양자화 (Median-Cut → K-means)
     ========================================================== */
  /** 불투명 픽셀만 표본 추출. skipEdge 면 투명 영역에 닿은 1px 테두리(AA 혼합색)를 제외. */
  function sampleColors(image, maxSamples, skipEdge) {
    var w = image.width, h = image.height, d = image.data, n = w * h;
    var step = Math.max(1, Math.floor(n / (maxSamples || 120000)));
    var out = [], strong = 0, weak = [];
    var edge = null;
    if (skipEdge) {
      edge = new Uint8Array(n);
      for (var e = 0; e < n; e++) {
        if (d[e * 4 + 3] >= 8) continue;
        var ex = e % w, ey = (e / w) | 0;
        if (ex > 0) edge[e - 1] = 1;
        if (ex < w - 1) edge[e + 1] = 1;
        if (ey > 0) edge[e - w] = 1;
        if (ey < h - 1) edge[e + w] = 1;
      }
    }
    for (var i = 0; i < n; i += step) {
      var o = i * 4, al = d[o + 3];
      if (al < 8) continue;
      if (edge && edge[i]) continue;
      if (al >= 200) { out.push(d[o], d[o + 1], d[o + 2]); strong++; }
      else if (weak.length < 3 * 4000) weak.push(d[o], d[o + 1], d[o + 2]);
    }
    if (strong < 24 && weak.length) out = out.concat(weak);
    if (!out.length) {
      for (var j = 0; j < n; j += step) {
        if (d[j * 4 + 3] < 8) continue;
        out.push(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]);
        if (out.length > 3000) break;
      }
    }
    if (!out.length) return [0, 0, 0];
    return out;
  }

  function boxStats(flat, idx, lo, hi) {
    var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    var sr = 0, sg = 0, sb = 0;
    for (var i = lo; i < hi; i++) {
      var o = idx[i] * 3, r = flat[o], g = flat[o + 1], b = flat[o + 2];
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
      sr += r; sg += g; sb += b;
    }
    var n = hi - lo || 1;
    return {
      range: Math.max(maxR - minR, maxG - minG, maxB - minB),
      mean: [sr / n, sg / n, sb / n], size: hi - lo
    };
  }

  /** 결정적 median-cut. flat = [r,g,b, r,g,b, ...] */
  function medianCut(flat, count) {
    var n = flat.length / 3;
    if (!n) return [[0, 0, 0]];
    var idx = new Int32Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;
    var boxes = [{ lo: 0, hi: n }];
    function stat(b) { return boxStats(flat, idx, b.lo, b.hi); }

    while (boxes.length < count) {
      var pick = -1, pickScore = -1;
      var minSize = Math.max(40, Math.floor(n * 0.004));
      for (var k = 0; k < boxes.length; k++) {
        var st = stat(boxes[k]);
        if (st.size < minSize) continue;          // 아주 작은 색 덩어리(AA 혼합색)는 승격하지 않는다
        var score = st.range * Math.pow(st.size, 0.25);
        if (score > pickScore) { pickScore = score; pick = k; }
      }
      if (pick < 0) break;
      var box = boxes[pick], bs = stat(box);
      // 색역이 가장 넓은 채널
      var ch = 0, best = -1;
      for (var c = 0; c < 3; c++) {
        var mn = 255, mx = 0;
        for (var j = box.lo; j < box.hi; j++) { var v = flat[idx[j] * 3 + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mx - mn > best) { best = mx - mn; ch = c; }
      }
      if (best <= 0) {   // 색역 0 → 더 쪼갤 필요 없음
        var anySplittable = false;
        for (var q = 0; q < boxes.length; q++) if (stat(boxes[q]).range > 0) { anySplittable = true; break; }
        if (!anySplittable) break;
        var alt = -1;
        for (var q2 = 0; q2 < boxes.length; q2++) if (stat(boxes[q2]).range > 0) { alt = q2; break; }
        if (alt < 0) break;
        ch = 0; box = boxes[alt]; bs = stat(box);
        var mn2 = 255, mx2 = 0;
        for (var c2 = 0; c2 < 3; c2++) {
          var lo2 = 255, hi2 = 0;
          for (var j2 = box.lo; j2 < box.hi; j2++) { var v2 = flat[idx[j2] * 3 + c2]; if (v2 < lo2) lo2 = v2; if (v2 > hi2) hi2 = v2; }
          if (hi2 - lo2 > mx2 - mn2) { mx2 = hi2; mn2 = lo2; ch = c2; }
        }
        pick = alt;
      }
      idx.subarray(box.lo, box.hi).sort(function (a, b) { return flat[a * 3 + ch] - flat[b * 3 + ch]; });
      var mid = box.lo + ((box.hi - box.lo) >> 1);
      if (mid <= box.lo || mid >= box.hi) continue;
      boxes.splice(pick, 1, { lo: box.lo, hi: mid }, { lo: mid, hi: box.hi });
      if (bs.size < 1) break;
    }
    return boxes.map(function (b) { return stat(b).mean; });
  }

  /** k-means 정제 (표본 기준) */
  function kmeansRefine(flat, palette, iterations) {
    var n = flat.length / 3, k = palette.length;
    if (!n || !k) return palette;
    var pal = palette.map(function (c) { return [c[0], c[1], c[2]]; });
    var assign = new Int32Array(n);
    for (var it = 0; it < (iterations || 4); it++) {
      var sum = [], cnt = new Float64Array(k);
      for (var c = 0; c < k; c++) sum.push([0, 0, 0]);
      for (var i = 0; i < n; i++) {
        var o = i * 3, r = flat[o], g = flat[o + 1], b = flat[o + 2];
        var bi = 0, bd = Infinity;
        for (var c2 = 0; c2 < k; c2++) {
          var p = pal[c2], dr = r - p[0], dg = g - p[1], db = b - p[2];
          var dd = dr * dr + dg * dg + db * db;
          if (dd < bd) { bd = dd; bi = c2; }
        }
        assign[i] = bi; cnt[bi]++;
        sum[bi][0] += r; sum[bi][1] += g; sum[bi][2] += b;
      }
      for (var c3 = 0; c3 < k; c3++) {
        if (cnt[c3] > 0) pal[c3] = [sum[c3][0] / cnt[c3], sum[c3][1] / cnt[c3], sum[c3][2] / cnt[c3]];
      }
    }
    return pal;
  }

  /** 너무 가까운 팔레트 항목 병합 (거리 < mergeDist) */
  function dedupePalette(pal, mergeDist) {
    var out = [];
    for (var i = 0; i < pal.length; i++) {
      var found = -1;
      for (var j = 0; j < out.length; j++) {
        if (Math.sqrt(dist2c(pal[i], out[j].c)) < mergeDist) { found = j; break; }
      }
      if (found >= 0) {
        var o = out[found];
        o.c = [(o.c[0] * o.n + pal[i][0]) / (o.n + 1), (o.c[1] * o.n + pal[i][1]) / (o.n + 1), (o.c[2] * o.n + pal[i][2]) / (o.n + 1)];
        o.n++;
      } else out.push({ c: [pal[i][0], pal[i][1], pal[i][2]], n: 1 });
    }
    return out.map(function (o) { return o.c; });
  }

  /**
   * 안티에일리어싱 혼합색 정리.
   * 두 색 A,B 사이(선분)에 놓인 색은 경계가 번진 색이므로, 점유율이 낮으면
   * 가까운 쪽 색으로 합친다. 빨간 점 같은 진짜 작은 색은 선분 위에 없으므로 살아남는다.
   */
  function pruneBlends(labels, palette, counts, totalOpaque) {
    var k = palette.length;
    if (k < 3 || !totalOpaque) return { palette: palette, merged: 0 };

    function segDist(p, a, b) {
      var abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      var apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
      var len2 = abx * abx + aby * aby + abz * abz;
      if (len2 < 1) return Math.sqrt(apx * apx + apy * apy + apz * apz);
      var t = clamp((apx * abx + apy * aby + apz * abz) / len2, 0, 1);
      var dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    var drop = new Int16Array(k).fill(-1);
    var isDrop = new Uint8Array(k);
    var minCount = Math.max(200, totalOpaque * 0.012);
    var merged = 0;
    for (var e = 0; e < k; e++) {
      if (counts[e] >= minCount) continue;
      var bestA = -1, bestB = -1, bestD = 1e9;
      for (var a = 0; a < k; a++) {
        if (a === e || isDrop[a]) continue;
        for (var b = a + 1; b < k; b++) {
          if (b === e || isDrop[b]) continue;
          var d = segDist(palette[e], palette[a], palette[b]);
          if (d < bestD) { bestD = d; bestA = a; bestB = b; }
        }
      }
      if (bestD > 24 || bestA < 0) continue;          // 선분 위가 아니면 진짜 색
      drop[e] = dist2c(palette[e], palette[bestA]) <= dist2c(palette[e], palette[bestB]) ? bestA : bestB;
      isDrop[e] = 1;
      merged++;
    }
    if (!merged) return { palette: palette, merged: 0 };

    function rootOf(x) { var guard = 0; while (drop[x] >= 0 && guard++ < 24) x = drop[x]; return x; }

    // 라벨 재배정 + 팔레트 압축
    var remap = new Int16Array(k);
    for (var i = 0; i < k; i++) remap[i] = rootOf(i);
    var keep = [], newIndex = new Int16Array(k).fill(-1);
    for (var j = 0; j < k; j++) {
      if (!isDrop[j]) { newIndex[j] = keep.length; keep.push(j); }
    }
    for (var p = 0; p < labels.length; p++) {
      if (labels[p] < 0) continue;
      var root = remap[labels[p]];
      labels[p] = newIndex[root] >= 0 ? newIndex[root] : 0;
    }
    return { palette: keep.map(function (x) { return palette[x]; }), merged: merged };
  }

  /**
   * 작은 강조색 구출.
   * Median-Cut 은 점유율이 낮은 색(로고의 빨간 점 등)을 큰 색에 섞어버린다.
   * 팔레트에 잘 맞지 않는 표본을 모아 새 색으로 승격한다.
   */
  function recoverColors(flat, pal, want) {
    var colors = pal.slice(0, want);
    var n = flat.length / 3;
    if (!n || colors.length >= want) return colors;
    var minKeep = Math.max(50, Math.floor(n * 0.0025));
    for (var pass = 0; pass < 6 && colors.length < want; pass++) {
      var bestI = -1, bestD = 55 * 55, resCount = 0;
      for (var i = 0; i < n; i++) {
        var o = i * 3, r = flat[o], g = flat[o + 1], b = flat[o + 2];
        var bd = Infinity;
        for (var c = 0; c < colors.length; c++) {
          var p = colors[c], dr = r - p[0], dg = g - p[1], db = b - p[2];
          var dd = dr * dr + dg * dg + db * db;
          if (dd < bd) bd = dd;
        }
        if (bd > 3600) {
          resCount++;
          if (bd > bestD) { bestD = bd; bestI = i; }
        }
      }
      if (bestI < 0 || resCount < minKeep) break;
      // 가장 벗어난 색 주변을 평균내 새 색으로
      var sr = flat[bestI * 3], sg = flat[bestI * 3 + 1], sb = flat[bestI * 3 + 2];
      var ar = 0, ag = 0, ab = 0, cnt = 0;
      for (var j = 0; j < n; j++) {
        var o2 = j * 3, r2 = flat[o2], g2 = flat[o2 + 1], b2 = flat[o2 + 2];
        var d2 = (r2 - sr) * (r2 - sr) + (g2 - sg) * (g2 - sg) + (b2 - sb) * (b2 - sb);
        if (d2 > 70 * 70) continue;
        var near = false;
        for (var c2 = 0; c2 < colors.length; c2++) {
          if (dist2c([r2, g2, b2], colors[c2]) < 2500) { near = true; break; }
        }
        if (near) continue;
        ar += r2; ag += g2; ab += b2; cnt++;
      }
      if (cnt < minKeep) break;
      colors.push([ar / cnt, ag / cnt, ab / cnt]);
    }
    return colors;
  }

  /**
   * 팔레트 산출 + 전 픽셀 라벨링.
   * @returns {{palette:number[][], labels:Int16Array, mse:number, blends:number}}
   */
  function quantize(image, colorCount, opts) {
    opts = opts || {};
    var w = image.width, h = image.height, d = image.data, n = w * h;
    var flat = sampleColors(image, opts.maxSamples || 120000, !!opts.skipEdge);
    var want = clamp(colorCount | 0, 1, 48);
    var pal = dedupePalette(medianCut(flat, want), 10);
    if (pal.length > 1 && want > 1) {
      pal = dedupePalette(kmeansRefine(flat, pal, opts.kmeansIterations || 4), 8);
      pal = recoverColors(flat, pal, want);      // 작은 강조색 구출
    }
    if (opts.palette && opts.palette.length) pal = opts.palette.map(function (c) { return c.slice(0, 3); });
    if (!pal.length) pal = [[0, 0, 0]];

    var labels = new Int16Array(n);
    var mse = 0, used = 0;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      if (d[o + 3] < 8) { labels[i] = -1; continue; }
      var r = d[o], g = d[o + 1], b = d[o + 2];
      var bi = 0, bd = Infinity;
      for (var c = 0; c < pal.length; c++) {
        var p = pal[c], dr = r - p[0], dg = g - p[1], db = b - p[2];
        var dd = dr * dr + dg * dg + db * db;
        if (dd < bd) { bd = dd; bi = c; }
      }
      labels[i] = bi; mse += bd; used++;
    }
    if (used) mse = mse / used;

    // AA 혼합색 정리 → 색 수를 실제 색만큼 줄인다
    var counts = new Float64Array(pal.length);
    for (var ci = 0; ci < n; ci++) if (labels[ci] >= 0) counts[labels[ci]]++;
    var pruned = pruneBlends(labels, pal, counts, used);
    pal = pruned.palette;

    return { palette: pal.map(function (p) { return [p[0], p[1], p[2]]; }), labels: labels, mse: mse, blends: pruned.merged };
  }

  /* ==========================================================
     4 · 배경 자동 투명화 (가장자리 연결 플러드필)
     ========================================================== */
  /**
   * 가장자리(또는 네 모서리)에서 시작해, 시작 픽셀 색과 tolerance 이내인
   * 연결 영역만 알파 0으로. 사진 속 인물처럼 중앙에 갇힌 같은 색은 건드리지 않는다.
   */
  function removeBackground(image, opts) {
    opts = opts || {};
    var mode = opts.mode || 'edges';
    if (mode === 'none') return { removed: 0, image: image };
    var w = image.width, h = image.height, d = image.data, n = w * h;
    var tol = clamp(opts.tolerance == null ? 30 : opts.tolerance, 0, 160);
    var tol2 = tol * tol;
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var origin = new Int32Array(n);
    var sp = 0, removed = 0;
    var sumR = 0, sumG = 0, sumB = 0;

    function push(i, oi) {
      if (seen[i]) return;
      if (d[i * 4 + 3] < 8) { seen[i] = 1; return; }
      var o = i * 4, q = oi * 4;
      var dr = d[o] - d[q], dg = d[o + 1] - d[q + 1], db = d[o + 2] - d[q + 2];
      if (dr * dr + dg * dg + db * db > tol2) return;
      seen[i] = 1; origin[i] = oi; stack[sp++] = i;
    }

    if (mode === 'corners') {
      push(0, 0); push(w - 1, w - 1); push((h - 1) * w, (h - 1) * w); push(n - 1, n - 1);
    } else {
      for (var x = 0; x < w; x++) { push(x, x); push((h - 1) * w + x, (h - 1) * w + x); }
      for (var y = 0; y < h; y++) { push(y * w, y * w); push(y * w + w - 1, y * w + w - 1); }
    }

    while (sp > 0) {
      var i2 = stack[--sp];
      sumR += d[i2 * 4]; sumG += d[i2 * 4 + 1]; sumB += d[i2 * 4 + 2];
      d[i2 * 4 + 3] = 0; removed++;
      var cx = i2 % w, cy = (i2 / w) | 0;
      if (cx > 0) push(i2 - 1, origin[i2]);
      if (cx < w - 1) push(i2 + 1, origin[i2]);
      if (cy > 0) push(i2 - w, origin[i2]);
      if (cy < h - 1) push(i2 + w, origin[i2]);
    }
    return {
      removed: removed,
      bgColor: removed ? [sumR / removed, sumG / removed, sumB / removed] : null,
      image: image
    };
  }

  /* ==========================================================
     4-B · 테두리 알파 디컨타미네이션
     ========================================================== */
  /**
   * 투명 영역에 닿은 픽셀은 배경색 B 와 전경색 F 의 혼합 C = tF + (1-t)B 로 본다.
   * t = (C-B)·(F-B)/|F-B|² 를 구해 알파에 반영하면, AA 테두리가 회색 \"테두리\"가 아니라
   * 반투명 경계가 되어 윤곽선이 서브픽셀 위치로 복원된다.
   */
  function decontaminate(image, labels, palette) {
    var w = image.width, h = image.height, d = image.data, n = w * h, touched = 0;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      if (d[o + 3] < 8) continue;
      var x = i % w, y = (i / w) | 0;
      var br = 0, bg = 0, bb = 0, cnt = 0;
      if (x > 0 && d[(i - 1) * 4 + 3] < 8) { var k1 = (i - 1) * 4; br += d[k1]; bg += d[k1 + 1]; bb += d[k1 + 2]; cnt++; }
      if (x < w - 1 && d[(i + 1) * 4 + 3] < 8) { var k2 = (i + 1) * 4; br += d[k2]; bg += d[k2 + 1]; bb += d[k2 + 2]; cnt++; }
      if (y > 0 && d[(i - w) * 4 + 3] < 8) { var k3 = (i - w) * 4; br += d[k3]; bg += d[k3 + 1]; bb += d[k3 + 2]; cnt++; }
      if (y < h - 1 && d[(i + w) * 4 + 3] < 8) { var k4 = (i + w) * 4; br += d[k4]; bg += d[k4 + 1]; bb += d[k4 + 2]; cnt++; }
      if (!cnt) continue;
      br /= cnt; bg /= cnt; bb /= cnt;
      var lab = labels[i];
      if (lab < 0 || !palette[lab]) continue;
      var F = palette[lab];
      var vx = F[0] - br, vy = F[1] - bg, vz = F[2] - bb;
      var den = vx * vx + vy * vy + vz * vz;
      if (den < 24) continue;   // 팔레트 색이 배경과 같으면 추정 불가 → 그대로 둔다
      var t = ((d[o] - br) * vx + (d[o + 1] - bg) * vy + (d[o + 2] - bb) * vz) / den;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var a = (d[o + 3] / 255) * t;
      if (a < 0.996) { d[o + 3] = Math.round(a * 255); touched++; }
    }
    return touched;
  }

  /* ==========================================================
     5 · 스펙클(미세 잡티) 제거
     ========================================================== */
  /**
   * 4-연결 성분 라벨링 후 area < minArea 인 성분을 주변 다수 색으로 흡수.
   * 단순 삭제 대신 흡수해서 경계가 깨지지 않는다.
   */
  function removeSpecks(labels, w, h, minArea, maxColor) {
    if (!minArea || minArea <= 0) return { removed: 0, pixels: 0 };
    var n = w * h;
    var seen = new Uint8Array(n);
    var stack = new Int32Array(n);
    var comp = new Int32Array(1024);
    var removed = 0, pixels = 0;
    var counts = new Int32Array((maxColor || 32) + 2);

    for (var s = 0; s < n; s++) {
      var lab = labels[s];
      if (seen[s] || lab < 0) continue;
      var sp = 0, clen = 0;
      stack[sp++] = s; seen[s] = 1;
      if (comp.length < 32) comp = new Int32Array(1024);
      while (sp > 0) {
        var i = stack[--sp];
        comp[clen++] = i;
        var x = i % w, y = (i / w) | 0;
        if (x > 0 && !seen[i - 1] && labels[i - 1] === lab) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && labels[i + 1] === lab) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && !seen[i - w] && labels[i - w] === lab) { seen[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && !seen[i + w] && labels[i + w] === lab) { seen[i + w] = 1; stack[sp++] = i + w; }
      }
      if (clen >= minArea) continue;
      // 주변 다수 색 찾기
      counts.fill(0);
      var bestLab = -2, bestCnt = -1;
      for (var q = 0; q < clen; q++) {
        var j = comp[q], jx = j % w, jy = (j / w) | 0;
        var nb = [jx > 0 ? j - 1 : -1, jx < w - 1 ? j + 1 : -1, jy > 0 ? j - w : -1, jy < h - 1 ? j + w : -1];
        for (var t = 0; t < 4; t++) {
          var m = nb[t];
          if (m < 0) continue;
          var ml = labels[m];
          if (ml === lab) continue;
          var key = ml < 0 ? counts.length - 1 : ml;
          counts[key]++;
          if (counts[key] > bestCnt) { bestCnt = counts[key]; bestLab = ml; }
        }
      }
      if (bestLab === -2) continue;
      for (var q2 = 0; q2 < clen; q2++) labels[comp[q2]] = bestLab;
      removed++; pixels += clen;
    }
    return { removed: removed, pixels: pixels };
  }

  /* ==========================================================
     6 · 서브픽셀 멤버십 (안티에일리어싱 복원)
     ========================================================== */
  /**
   * 각 픽셀에서 가장 가까운 두 팔레트 색을 구해, 그 사이 블렌드 비율을
   * 커버리지로 쓴다. AA 경계 픽셀의 실제 혼합비가 0.5 임계값의 위치를
   * 밀어주므로 윤곽선이 픽셀 격자보다 정밀해진다.
   */
  function buildSoft(image, labels, palette) {
    var n = image.width * image.height, d = image.data, k = palette.length;
    var i2 = new Uint8Array(n), w1 = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var lab = labels[i];
      if (lab < 0) { i2[i] = 255; w1[i] = 1; continue; }
      var o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2];
      var p0 = palette[lab];
      var dr = r - p0[0], dg = g - p0[1], db = b - p0[2];
      var d1 = dr * dr + dg * dg + db * db;
      var bi = 255, bd = Infinity;
      for (var c = 0; c < k; c++) {
        if (c === lab) continue;
        var p = palette[c], er = r - p[0], eg = g - p[1], eb = b - p[2];
        var dd = er * er + eg * eg + eb * eb;
        if (dd < bd) { bd = dd; bi = c; }
      }
      i2[i] = bi;
      if (bi === 255) { w1[i] = 1; continue; }
      var s1 = Math.sqrt(d1), s2 = Math.sqrt(bd);
      var sum = s1 + s2;
      // w1 = 이 색의 커버리지(가장 가까운 색의 비중) → 색이 정확하면 1, 반반이면 0.5
      w1[i] = sum > 0 ? s2 / sum : 1;
    }
    return { i2: i2, w1: w1 };
  }

  /* ==========================================================
     7 · Marching Squares 등고선
     ========================================================== */
  /**
   * field(0~1) 를 threshold 로 자른 등고선을 폐곡선 배열로 뽑는다.
   * 바깥 1px 제로 패딩 → 이미지 가장자리에 닿은 도형도 닫힌 윤곽이 된다.
   * @returns {Array<Array<[number,number]>>} 픽셀 좌표계(픽셀 중심=정수) 폐곡선
   */
  function traceField(field, w, h, threshold) {
    var t = threshold == null ? 0.5 : threshold;
    var pw = w + 2, ph = h + 2;
    var pad = new Float32Array(pw * ph);
    for (var y = 0; y < h; y++) {
      var src = y * w, dst = (y + 1) * pw + 1;
      for (var x = 0; x < w; x++) pad[dst + x] = field[src + x];
    }
    var segs = [];
    // 셀 네 귀퉁이 값 a(좌상) b(우상) c(우하) d(좌하) → 등고선 점 4개
    var ax = 0, ay = 0, bx = 0, by = 0, qx = 0, qy = 0, dx = 0, dy = 0;

    function pushSeg(x1, y1, x2, y2) { segs.push(x1 - 1, y1 - 1, x2 - 1, y2 - 1); }

    for (var cy = 0; cy < ph - 1; cy++) {
      for (var cx = 0; cx < pw - 1; cx++) {
        var o = cy * pw + cx;
        var a = pad[o], b2 = pad[o + 1], c = pad[o + pw + 1], dd = pad[o + pw];
        var ina = a >= t ? 1 : 0, inb = b2 >= t ? 1 : 0, inc = c >= t ? 1 : 0, ind = dd >= t ? 1 : 0;
        var code = (ina << 3) | (inb << 2) | (inc << 1) | ind;
        if (code === 0 || code === 15) continue;

        // 위: a→b / 오른쪽: b→c / 아래: d→c / 왼쪽: a→d
        ax = cx + (t - a) / (b2 - a); ay = cy;
        bx = cx + 1; by = cy + (t - b2) / (c - b2);
        qx = cx + (t - dd) / (c - dd); qy = cy + 1;
        dx = cx; dy = cy + (t - a) / (dd - a);

        switch (code) {
          case 1: pushSeg(dx, dy, qx, qy); break;
          case 2: pushSeg(qx, qy, bx, by); break;
          case 3: pushSeg(dx, dy, bx, by); break;
          case 4: pushSeg(ax, ay, bx, by); break;
          case 5: {
            if ((a + b2 + c + dd) / 4 >= t) { pushSeg(dx, dy, ax, ay); pushSeg(bx, by, qx, qy); }
            else { pushSeg(ax, ay, bx, by); pushSeg(dx, dy, qx, qy); }
            break;
          }
          case 6: pushSeg(ax, ay, qx, qy); break;
          case 7: pushSeg(dx, dy, ax, ay); break;
          case 8: pushSeg(ax, ay, dx, dy); break;
          case 9: pushSeg(ax, ay, qx, qy); break;
          case 10: {
            if ((a + b2 + c + dd) / 4 >= t) { pushSeg(ax, ay, bx, by); pushSeg(dx, dy, qx, qy); }
            else { pushSeg(ax, ay, dx, dy); pushSeg(qx, qy, bx, by); }
            break;
          }
          case 11: pushSeg(ax, ay, bx, by); break;
          case 12: pushSeg(dx, dy, bx, by); break;
          case 13: pushSeg(bx, by, qx, qy); break;
          case 14: pushSeg(qx, qy, dx, dy); break;
        }
      }
    }

    if (!segs.length) return [];
    var m = segs.length / 4;
    var map = new Map();
    // 좌표 키: 1/1000 px 단위 정수 두 개를 충돌 없이 묶는다 (|좌표| < 2000 가정)
    function key(x, y) { return (Math.round(x * 1000) + 2000000) * 4000000 + (Math.round(y * 1000) + 2000000); }
    for (var s = 0; s < m; s++) {
      var k1 = key(segs[s * 4], segs[s * 4 + 1]);
      var k2 = key(segs[s * 4 + 2], segs[s * 4 + 3]);
      var a1 = map.get(k1); if (!a1) { a1 = []; map.set(k1, a1); } a1.push(s);
      var a2 = map.get(k2); if (!a2) { a2 = []; map.set(k2, a2); } a2.push(s);
    }
    var used = new Uint8Array(m);
    var loops = [];
    for (var s2 = 0; s2 < m; s2++) {
      if (used[s2]) continue;
      used[s2] = 1;
      var sx = segs[s2 * 4], sy = segs[s2 * 4 + 1];
      var loop = [sx, sy];
      var ex = segs[s2 * 4 + 2], ey = segs[s2 * 4 + 3];
      var guard = 0;
      while (guard++ < m + 4) {
        loop.push(ex, ey);
        if (Math.abs(ex - sx) < 1e-5 && Math.abs(ey - sy) < 1e-5) break;
        var cand = map.get(key(ex, ey));
        var next = -1;
        if (cand) for (var q = 0; q < cand.length; q++) if (!used[cand[q]]) { next = cand[q]; break; }
        if (next < 0) { loop.push(sx, sy); break; }
        used[next] = 1;
        // 방향 무관: 끝점이 현재 점과 같으면 반대로 탈출
        var nx1 = segs[next * 4], ny1 = segs[next * 4 + 1];
        if (Math.abs(nx1 - ex) < 1e-5 && Math.abs(ny1 - ey) < 1e-5) {
          ex = segs[next * 4 + 2]; ey = segs[next * 4 + 3];
        } else {
          ex = nx1; ey = ny1;
        }
      }
      var pts = [];
      for (var p = 0; p < loop.length; p += 2) pts.push([loop[p], loop[p + 1]]);
      // 중복 끝점 제거
      while (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
      if (pts.length >= 3) loops.push(pts);
    }
    return loops;
  }

  /* ==========================================================
     8 · Douglas–Peucker 단순화
     ========================================================== */
  function simplifyDP(points, eps) {
    var n = points.length;
    if (n < 3) return points.slice();
    var keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    var eps2 = eps * eps;
    while (stack.length) {
      var seg = stack.pop(), i0 = seg[0], i1 = seg[1];
      if (i1 - i0 < 2) continue;
      var ax = points[i0][0], ay = points[i0][1];
      var bx = points[i1][0], by = points[i1][1];
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var best = -1, bestD = -1;
      for (var i = i0 + 1; i < i1; i++) {
        var px = points[i][0], py = points[i][1], d;
        if (len2 < 1e-12) d = dist2(px, py, ax, ay);
        else {
          var tt = ((px - ax) * dx + (py - ay) * dy) / len2;
          tt = clamp(tt, 0, 1);
          d = dist2(px, py, ax + tt * dx, ay + tt * dy);
        }
        if (d > bestD) { bestD = d; best = i; }
      }
      if (bestD > eps2) { keep[best] = 1; stack.push([i0, best]); stack.push([best, i1]); }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  /** 닫힌 폴리곤 단순화: 0번과 가장 먼 점에서 두 갈래로 나눠 DP */
  function simplifyClosed(points, eps) {
    var n = points.length;
    if (n < 4) return points.slice();
    var far = 1, fd = -1;
    for (var i = 1; i < n; i++) {
      var d = dist2(points[i][0], points[i][1], points[0][0], points[0][1]);
      if (d > fd) { fd = d; far = i; }
    }
    var a = simplifyDP(points.slice(0, far + 1), eps);
    var b = simplifyDP(points.slice(far).concat([points[0]]), eps);
    var out = a.slice(0, a.length - 1).concat(b.slice(0, b.length - 1));
    if (out.length < 3) return points.slice();
    return out;
  }

  /* ==========================================================
     9 · 3차 베지어 피팅 (Schneider, Graphics Gems)
     ========================================================== */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function norm(a) { var l = Math.hypot(a[0], a[1]); return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l]; }

  function B0(u) { var m = 1 - u; return m * m * m; }
  function B1(u) { var m = 1 - u; return 3 * u * m * m; }
  function B2(u) { var m = 1 - u; return 3 * u * u * m; }
  function B3(u) { return u * u * u; }

  function bezierAt(bez, u) {
    var p0 = bez[0], p1 = bez[1], p2 = bez[2], p3 = bez[3];
    var b0 = B0(u), b1 = B1(u), b2 = B2(u), b3 = B3(u);
    return [b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
            b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]];
  }
  function bezierPrime(bez, u) {
    var p0 = bez[0], p1 = bez[1], p2 = bez[2], p3 = bez[3];
    var m = 1 - u;
    var v = [3 * m * m * (p1[0] - p0[0]) + 6 * m * u * (p2[0] - p1[0]) + 3 * u * u * (p3[0] - p2[0]),
             3 * m * m * (p1[1] - p0[1]) + 6 * m * u * (p2[1] - p1[1]) + 3 * u * u * (p3[1] - p2[1])];
    return v;
  }
  function bezierPrime2(bez, u) {
    var p0 = bez[0], p1 = bez[1], p2 = bez[2], p3 = bez[3];
    var m = 1 - u;
    return [6 * m * (p2[0] - 2 * p1[0] + p0[0]) + 6 * u * (p3[0] - 2 * p2[0] + p1[0]),
            6 * m * (p2[1] - 2 * p1[1] + p0[1]) + 6 * u * (p3[1] - 2 * p2[1] + p1[1])];
  }

  function chordLength(pts) {
    var u = [0], total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      u.push(total);
    }
    if (total < 1e-12) { for (var j = 0; j < u.length; j++) u[j] = j / (u.length - 1); return u; }
    for (var k = 0; k < u.length; k++) u[k] /= total;
    return u;
  }

  function generateBezier(pts, u, t1, t2, error) {
    var n = pts.length, p0 = pts[0], p3 = pts[n - 1];
    var C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
    for (var i = 0; i < n; i++) {
      var ui = u[i];
      var a1 = mul(t1, B1(ui)), a2 = mul(t2, B2(ui));
      C00 += dot(a1, a1); C01 += dot(a1, a2); C11 += dot(a2, a2);
      var base = add(add(mul(p0, B0(ui)), mul(p0, B1(ui))), add(mul(p3, B2(ui)), mul(p3, B3(ui))));
      var tmp = sub(pts[i], base);
      X0 += dot(a1, tmp); X1 += dot(a2, tmp);
    }
    var det = C00 * C11 - C01 * C01;
    var al = 0, ar = 0;
    if (Math.abs(det) > 1e-9) {
      al = (X0 * C11 - X1 * C01) / det;
      ar = (C00 * X1 - C01 * X0) / det;
    }
    var segLen = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    var lo = segLen * 0.02, hi = segLen * 1.25;
    if (!(al > lo) || !(ar > lo) || al > hi || ar > hi || !isFinite(al) || !isFinite(ar)) {
      var d = segLen / 3;
      if (d < 1e-6) d = (error || 1) * 2;
      al = ar = d;
    }
    return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
  }

  function maxError(pts, bez, u) {
    var mx = 0, idx = Math.floor(pts.length / 2);
    for (var i = 1; i < pts.length - 1; i++) {
      var p = bezierAt(bez, u[i]);
      var d = dist2(p[0], p[1], pts[i][0], pts[i][1]);
      if (d >= mx) { mx = d; idx = i; }
    }
    return { err: mx, index: idx };
  }

  function reparameterize(pts, bez, u) {
    var out = new Array(u.length);
    for (var i = 0; i < u.length; i++) {
      var d = sub(bezierAt(bez, u[i]), pts[i]);
      var q1 = bezierPrime(bez, u[i]), q2 = bezierPrime2(bez, u[i]);
      var num = dot(d, q1), den = dot(q1, q1) + dot(d, q2);
      out[i] = Math.abs(den) < 1e-12 ? u[i] : u[i] - num / den;
    }
    return out;
  }

  function fitCubic(pts, t1, t2, error, out, depth) {
    var n = pts.length;
    if (n === 2) { out.push({ type: 'L', x: pts[1][0], y: pts[1][1] }); return; }
    var u = chordLength(pts);
    var bez = generateBezier(pts, u, t1, t2, error);
    var e = maxError(pts, bez, u);
    if (e.err <= error * error) { pushC(bez); return; }
    if (e.err <= error * error * 16) {
      for (var k = 0; k < 4; k++) {
        u = reparameterize(pts, bez, u);
        bez = generateBezier(pts, u, t1, t2, error);
        e = maxError(pts, bez, u);
        if (e.err <= error * error) { pushC(bez); return; }
      }
    }
    if (depth > 22) { pushC(bez); return; }
    var split = e.index;
    if (split <= 0) split = 1;
    if (split >= n - 1) split = n - 2;
    var c = pts[split];
    var prev = pts[split - 1], next = pts[split + 1];
    var tc = norm([(next[0] - prev[0]), (next[1] - prev[1])]);
    if (tc[0] === 0 && tc[1] === 0) tc = t1;
    fitCubic(pts.slice(0, split + 1), t1, [-tc[0], -tc[1]], error, out, depth + 1);
    fitCubic(pts.slice(split), tc, t2, error, out, depth + 1);

    function pushC(b) {
      out.push({ type: 'C', x1: b[1][0], y1: b[1][1], x2: b[2][0], y2: b[2][1], x: b[3][0], y: b[3][1] });
    }
  }

  function fitOpen(pts, error) {
    var out = [];
    if (pts.length < 2) return out;
    if (pts.length === 2) { out.push({ type: 'L', x: pts[1][0], y: pts[1][1] }); return out; }
    // 첫/끝에서 중복점 제거
    var clean = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      if (dist2(pts[i][0], pts[i][1], clean[clean.length - 1][0], clean[clean.length - 1][1]) > 1e-10) clean.push(pts[i]);
    }
    if (clean.length === 2) { out.push({ type: 'L', x: clean[1][0], y: clean[1][1] }); return out; }
    // 전부 한 직선 위에 있으면 베지어 대신 L 하나 (용량 절약)
    var a = clean[0], b = clean[clean.length - 1];
    var ddx = b[0] - a[0], ddy = b[1] - a[1];
    var len = Math.hypot(ddx, ddy);
    if (len > 1e-6) {
      var maxOff = 0;
      for (var k = 1; k < clean.length - 1; k++) {
        var t = ((clean[k][0] - a[0]) * ddx + (clean[k][1] - a[1]) * ddy) / (len * len);
        t = clamp(t, 0, 1);
        var off = Math.hypot(clean[k][0] - (a[0] + t * ddx), clean[k][1] - (a[1] + t * ddy));
        if (off > maxOff) maxOff = off;
      }
      if (maxOff <= error) { out.push({ type: 'L', x: b[0], y: b[1] }); return out; }
    }
    var t1 = norm(sub(clean[1], clean[0]));
    var t2 = norm(sub(clean[clean.length - 2], clean[clean.length - 1]));
    if (t1[0] === 0 && t1[1] === 0) t1 = [1, 0];
    if (t2[0] === 0 && t2[1] === 0) t2 = [-1, 0];
    var before = out.length;
    fitCubic(clean, t1, t2, error, out, 0);
    return out;
  }

  /* ==========================================================
     10 · 폐곡선 → 경로 명령
     ========================================================== */
  /**
   * 코너(각도 임계)로 나눈 구간마다 베지어 피팅. 코너는 꺾여야 하고
   * 곡선 구간은 매끈해야 한다.
   */
  function fitClosedLoop(points, opts) {
    var n = points.length;
    if (n < 3) return null;
    var err = opts.error == null ? 0.6 : opts.error;
    var cornerDeg = opts.cornerAngle == null ? 72 : opts.cornerAngle;
    var cornerCos = Math.cos(cornerDeg * Math.PI / 180);
    var minLen = Math.max(err * 2.2, 0.9);

    function cornerAt(i) {
      var p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n];
      var l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      var l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (l1 < minLen || l2 < minLen) return false;   // 짧은 변은 각도 추정 불가
      var cos = dot(norm(sub(p1, p0)), norm(sub(p2, p1)));
      return cos < cornerCos;
    }

    var corners = [];
    for (var i = 0; i < n; i++) if (cornerAt(i)) corners.push(i);
    if (!corners.length) {
      var far = 0, fd = -1;
      for (var j = 0; j < n; j++) {
        var d = dist2(points[j][0], points[j][1], points[0][0], points[0][1]);
        if (d > fd) { fd = d; far = j; }
      }
      corners = [0, far];
    }

    var start = corners[0];
    var runs = [];
    for (var c = 0; c < corners.length; c++) {
      var a = corners[c], b = corners[(c + 1) % corners.length];
      var seq = [points[a]], k = a, guard = 0;
      while (k !== b && guard++ < n + 2) { k = (k + 1) % n; seq.push(points[k]); }
      if (seq.length >= 2) runs.push(seq);
    }

    var segsOut = [];
    for (var r = 0; r < runs.length; r++) {
      var pts = runs[r];
      var segs = fitOpen(pts, err);
      for (var s = 0; s < segs.length; s++) segsOut.push(segs[s]);
    }
    if (!segsOut.length) return null;
    return { start: points[start], segs: segsOut };
  }

  function commandsToPath(start, segs, digits) {
    if (!segs.length) return '';
    var parts = ['M' + pair(start[0], start[1], digits)];
    for (var i = 0; i < segs.length; i++) {
      var c = segs[i];
      if (c.type === 'L') parts.push('L' + pair(c.x, c.y, digits));
      else parts.push('C' + pair(c.x1, c.y1, digits) + ' ' + pair(c.x2, c.y2, digits) + ' ' + pair(c.x, c.y, digits));
    }
    return parts.join('') + 'Z';
  }

  function loopArea(points) {
    var a = 0;
    for (var i = 0, n = points.length; i < n; i++) {
      var p = points[i], q = points[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  /* ==========================================================
     11 · 파이프라인
     ========================================================== */
  /**
   * @param {{width:number,height:number,data:any}} input
   * @param {object} options colors / background / minArea / simplify /
   *   cornerAngle / digits / maxSide / palette
   */
  function vectorize(input, options) {
    var o = options || {};
    var t0 = nowMs();
    if (!input || !input.width || !input.height || !input.data) throw new Error('image required');

    var fitted = fitImage(input, o.maxSide || 1400);
    var srcData = fitted.data;
    // 배경 제거·디컨타미네이션이 픽셀을 바꾸므로, 호출자가 넘긴 원본은 건드리지 않는다
    if (o.background && (o.background.mode || 'edges') !== 'none') {
      srcData = new Uint8ClampedArray(srcData.length);
      srcData.set(fitted.data);
    }
    var img = { width: fitted.width, height: fitted.height, data: srcData };
    var w = img.width, h = img.height, n = w * h;

    // 1) 배경
    var bg = { mode: o.background ? (o.background.mode || 'edges') : 'none', tolerance: o.background ? o.background.tolerance : 30 };
    var bgRes = removeBackground(img, bg);

    // 2) 양자화 (배경을 지웠으면 AA 테두리는 표본에서 제외)
    var q = quantize(img, o.colors || 6, {
      maxSamples: o.maxSamples,
      skipEdge: bgRes.removed > 0,
      palette: o.palette,
      kmeansIterations: o.kmeansIterations
    });
    var labels = q.labels, palette = q.palette;

    // 2-B) 테두리 알파 복원 → 서브픽셀 윤곽의 근거
    if (bgRes.removed > 0) decontaminate(img, labels, palette);
    var alpha = alphaOf(img);

    // 3) 스펙클
    var specks = removeSpecks(labels, w, h, o.minArea == null ? 4 : o.minArea, palette.length);

    // 4) 서브픽셀 멤버십
    var soft = buildSoft(img, labels, palette);

    // 5) 레이어별 윤곽 → 정리
    var eps = o.simplify == null ? 0.8 : o.simplify;
    var fitErr = Math.max(0.32, eps * 0.8);
    var digits = o.digits == null ? 2 : clamp(o.digits | 0, 0, 3);
    var layers = [];
    var field = new Float32Array(n);
    var totalRawPoints = 0, totalAnchors = 0, totalLoops = 0;

    for (var c = 0; c < palette.length; c++) {
      var any = false;
      for (var i = 0; i < n; i++) {
        var af = alpha[i] > 0 ? alpha[i] : 0;
        if (labels[i] === c) {
          var wv = soft.w1[i] > 0.52 ? soft.w1[i] : 0.52;
          field[i] = wv * af;
          any = true;
        } else if (soft.i2[i] === c) {
          // 경계 AA 픽셀: 두 번째 색 족의 커버리지(항상 0.5 미만)를 남긴다
          var v2 = Math.min(0.49, 1 - soft.w1[i]) * af;
          field[i] = v2 > 0.02 ? v2 : 0;
          if (v2 > 0.02) any = true;
        } else field[i] = 0;
      }
      if (!any) continue;

      var loops = traceField(field, w, h, 0.5);
      if (!loops.length) continue;
      var area = 0, dparts = [];
      var loopAnchors = 0, loopCount = 0;
      var minLoop = o.minLoopArea == null ? 1.2 : o.minLoopArea;
      for (var li = 0; li < loops.length; li++) {
        var raw = loops[li];
        var ar = loopArea(raw);
        var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
        for (var rb = 0; rb < raw.length; rb++) {
          if (raw[rb][0] < bx0) bx0 = raw[rb][0];
          if (raw[rb][0] > bx1) bx1 = raw[rb][0];
          if (raw[rb][1] < by0) by0 = raw[rb][1];
          if (raw[rb][1] > by1) by1 = raw[rb][1];
        }
        var bw = bx1 - bx0, bh = by1 - by0;
        // 계단 꼭지에서 생기는 슬리버(면적≈0) 제거
        if (ar < minLoop) continue;
        if (ar < 3 && bw < 2 && bh < 2) { totalRawPoints += raw.length; continue; }
        // 얇고 긴 실오라기(AA 테두리 잔여물) 제거 — 둘레²/면적이 큰 경우
        if (ar < 12) {
          var perim = 0;
          for (var pi = 0; pi < raw.length; pi++) {
            var pj = (pi + 1) % raw.length;
            perim += Math.hypot(raw[pi][0] - raw[pj][0], raw[pi][1] - raw[pj][1]);
          }
          if (perim * perim / ar > 40) { totalRawPoints += raw.length; continue; }
        }
        totalRawPoints += raw.length;
        var simp = simplifyClosed(raw, eps);
        var fit = fitClosedLoop(simp, { error: fitErr, cornerAngle: o.cornerAngle == null ? 72 : o.cornerAngle });
        if (!fit) continue;
        var segs = fit.segs;
        if (segs.length) {
          var last = segs[segs.length - 1];
          var gap = Math.hypot(last.x - fit.start[0], last.y - fit.start[1]);
          if (gap < Math.max(0.75, fitErr * 2.2)) { last.x = fit.start[0]; last.y = fit.start[1]; }
        }
        dparts.push(commandsToPath(fit.start, segs, digits));
        area += ar;
        loopAnchors += segs.length;
        loopCount++;
      }
      if (!dparts.length) continue;
      totalAnchors += loopAnchors;
      totalLoops += loopCount;
      layers.push({
        color: q.palette[c],
        hex: rgbToHex(q.palette[c]),
        d: dparts.join(''),
        area: area,
        loopCount: loopCount,
        anchors: loopAnchors
      });
    }

    // 큰 면적 먼저 → 작은 도형이 위에 올라간다
    layers.sort(function (a, b) { return b.area - a.area; });

    var svgBytes = 0;
    for (var g = 0; g < layers.length; g++) svgBytes += layers[g].d.length + 40;

    return {
      version: VERSION,
      width: w, height: h,
      sourceWidth: input.width, sourceHeight: input.height,
      scale: fitted.scale,
      palette: palette.map(function (p) { return { rgb: p.map(Math.round), hex: rgbToHex(p) }; }),
      layers: layers,
      stats: {
        ms: Math.round(nowMs() - t0),
        colors: palette.length,
        usedColors: layers.length,
        loops: totalLoops,
        anchors: totalAnchors,
        rawPoints: totalRawPoints,
        reduction: totalRawPoints > 0 ? 1 - totalAnchors / totalRawPoints : 0,
        svgBytes: svgBytes,
        mse: q.mse,
        removedBackground: bgRes.removed,
        removedSpecks: specks.removed,
        speckPixels: specks.pixels,
        simplify: eps,
        digits: digits
      }
    };
  }

  /* ==========================================================
     12 · 내보내기
     ========================================================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /** EPS/PDF 는 7bit ASCII 만: 한글 등은 버린다 */
  function ascii(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, ''); }

  /** SVG — 외부 참조 0, 색상별 <g>, 클린 <path> */
  function buildSVG(result, opts) {
    opts = opts || {};
    var w = result.width, h = result.height;
    var ow = opts.width || result.sourceWidth || w;
    var oh = opts.height || result.sourceHeight || h;
    var title = opts.title || 'Vector artwork';
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(ow, 2) + '" height="' + fmt(oh, 2) +
             '" viewBox="0 0 ' + fmt(w, 2) + ' ' + fmt(h, 2) + '" role="img" aria-label="' + esc(title) + '">');
    out.push('<title>' + esc(title) + '</title>');
    for (var i = 0; i < result.layers.length; i++) {
      var L = result.layers[i];
      out.push('<g id="c' + (i + 1) + '" fill="' + L.hex + '" fill-rule="evenodd"><path d="' + L.d + '"/></g>');
    }
    out.push('</svg>');
    return out.join('\n');
  }

  /** EPS — 실제 PostScript Level 2, 1:1 베지어 변환 */
  function buildEPS(result, opts) {
    opts = opts || {};
    var w = result.width, h = result.height;
    var cmyk = !!opts.cmyk;
    var digits = opts.digits == null ? result.stats.digits : opts.digits;
    var scale = opts.scale || 1;           // 1pt = 1px (72dpi 기준)
    var W = w * scale, H = h * scale;
    var lines = [];
    lines.push('%!PS-Adobe-3.0 EPSF-3.0');
    lines.push('%%Creator: One-Tap Vector Studio ' + VERSION);
    lines.push('%%Title: ' + ascii(opts.title || 'vector-artwork'));
    lines.push('%%CreationDate: ' + new Date().toISOString().slice(0, 10));
    lines.push('%%BoundingBox: 0 0 ' + Math.ceil(W) + ' ' + Math.ceil(H));
    lines.push('%%HiResBoundingBox: 0 0 ' + W.toFixed(3) + ' ' + H.toFixed(3));
    lines.push('%%DocumentData: Clean7Bit');
    lines.push('%%LanguageLevel: 2');
    lines.push('%%Pages: 1');
    lines.push('%%EndComments');
    lines.push('%%BeginProlog');
    lines.push('% 1 unit = 1 pt, y axis flipped to PostScript orientation.');
    lines.push('%%EndProlog');
    lines.push('gsave');
    if (scale !== 1) lines.push(scale.toFixed(4) + ' 0 0 ' + scale.toFixed(4) + ' 0 0 scale');
    lines.push('0 setlinejoin 0 setlinecap');

    function P(x, y) { return fmt(x, digits) + ' ' + fmt(h - y, digits); }

    for (var i = 0; i < result.layers.length; i++) {
      var L = result.layers[i];
      var rgb = L.color;
      if (cmyk) {
        var c = rgbToCmyk(rgb);
        lines.push(fmt(c[0], 4) + ' ' + fmt(c[1], 4) + ' ' + fmt(c[2], 4) + ' ' + fmt(c[3], 4) + ' setcmykcolor');
      } else {
        lines.push(fmt(rgb[0] / 255, 4) + ' ' + fmt(rgb[1] / 255, 4) + ' ' + fmt(rgb[2] / 255, 4) + ' setrgbcolor');
      }
      var subpaths = L.d.split('Z');
      for (var s = 0; s < subpaths.length; s++) {
        var d = subpaths[s];
        if (!d) continue;
        var tokens = d.match(/[MLC]|-?\d*\.?\d+/g) || [];
        var k = 0, cmd = '';
        while (k < tokens.length) {
          var tk = tokens[k];
          if (tk === 'M' || tk === 'L' || tk === 'C') { cmd = tk; k++; continue; }
          if (cmd === 'M') { lines.push(P(+tokens[k], +tokens[k + 1]) + ' moveto'); k += 2; cmd = 'L'; }
          else if (cmd === 'L') { lines.push(P(+tokens[k], +tokens[k + 1]) + ' lineto'); k += 2; }
          else if (cmd === 'C') {
            lines.push(P(+tokens[k], +tokens[k + 1]) + ' ' + P(+tokens[k + 2], +tokens[k + 3]) + ' ' +
                       P(+tokens[k + 4], +tokens[k + 5]) + ' curveto');
            k += 6;
          } else k++;
        }
        lines.push('closepath');
      }
      lines.push('eofill');
    }
    lines.push('grestore');
    lines.push('showpage');
    lines.push('%%EOF');
    return lines.join('\n') + '\n';
  }

  /** PDF 1.4 벡터 스트림 (Adobe Illustrator에서 .ai 로 열리는 PDF 호환) */
  function buildPDF(result, opts) {
    opts = opts || {};
    var w = result.width, h = result.height, digits = opts.digits == null ? result.stats.digits : opts.digits;
    var cmyk = !!opts.cmyk;
    var W = w, H = h;
    var content = [];
    content.push('q');
    content.push('1 0 0 -1 0 ' + fmt(H, 3) + ' cm');     // 이미지 좌표(y아래) → PDF 좌표
    content.push(cmyk ? '/DeviceCMYK cs' : '/DeviceRGB cs');
    for (var i = 0; i < result.layers.length; i++) {
      var L = result.layers[i];
      if (cmyk) {
        var c = rgbToCmyk(L.color);
        content.push(fmt(c[0], 4) + ' ' + fmt(c[1], 4) + ' ' + fmt(c[2], 4) + ' ' + fmt(c[3], 4) + ' k');
      } else {
        content.push(fmt(L.color[0] / 255, 4) + ' ' + fmt(L.color[1] / 255, 4) + ' ' + fmt(L.color[2] / 255, 4) + ' rg');
      }
      var subpaths = L.d.split('Z');
      for (var s = 0; s < subpaths.length; s++) {
        var d = subpaths[s];
        if (!d) continue;
        var tokens = d.match(/[MLC]|-?\d*\.?\d+/g) || [];
        var k = 0, cmd = '';
        var buf = [];
        while (k < tokens.length) {
          var tk = tokens[k];
          if (tk === 'M' || tk === 'L' || tk === 'C') { cmd = tk; k++; continue; }
          if (cmd === 'M') { buf.push(fmt(+tokens[k], digits) + ' ' + fmt(+tokens[k + 1], digits) + ' m'); k += 2; cmd = 'L'; }
          else if (cmd === 'L') { buf.push(fmt(+tokens[k], digits) + ' ' + fmt(+tokens[k + 1], digits) + ' l'); k += 2; }
          else if (cmd === 'C') {
            buf.push(fmt(+tokens[k], digits) + ' ' + fmt(+tokens[k + 1], digits) + ' ' +
                     fmt(+tokens[k + 2], digits) + ' ' + fmt(+tokens[k + 3], digits) + ' ' +
                     fmt(+tokens[k + 4], digits) + ' ' + fmt(+tokens[k + 5], digits) + ' c');
            k += 6;
          } else k++;
        }
        if (buf.length) { buf.push('h'); content.push(buf.join('\n')); }
      }
      content.push('f*');
    }
    content.push('Q');
    var stream = content.join('\n') + '\n';

    var objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fmt(W, 3) + ' ' + fmt(H, 3) + '] ' +
              '/Resources << /ProcSet [/PDF] >> /Contents 4 0 R >>';
    objs[4] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
    objs[5] = '<< /Title (' + ascii(opts.title || 'Vector artwork').replace(/[()\\]/g, ' ') + ') ' +
              '/Creator (One-Tap Vector Studio ' + VERSION + ') /Producer (One-Tap Vector Studio ' + VERSION + ') ' +
              '/CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + ') >>';

    var out = '%PDF-1.4\n';
    var offsets = [];
    for (var oi = 1; oi <= 5; oi++) {
      offsets[oi] = out.length;
      out += oi + ' 0 obj\n' + objs[oi] + '\nendobj\n';
    }
    var xref = out.length;
    out += 'xref\n0 6\n';
    out += '0000000000 65535 f \n';
    for (var xi = 1; xi <= 5; xi++) {
      out += ('0000000000' + offsets[xi]).slice(-10) + ' 00000 n \n';
    }
    out += 'trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return out;
  }

  /** UTF-8 바이트 길이 (ASCII 만 쓰지만 안전하게) */
  function byteLength(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    return unescape(encodeURIComponent(str)).length;
  }

  /* ==========================================================
     13 · 공개 API
     ========================================================== */
  return {
    version: VERSION,
    /* 이미지 */
    fitImage: fitImage,
    /* 색 */
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    rgbToCmyk: rgbToCmyk,
    luminance: lum,
    /* 양자화 */
    sampleColors: sampleColors,
    medianCut: medianCut,
    kmeansRefine: kmeansRefine,
    dedupePalette: dedupePalette,
    recoverColors: recoverColors,
    quantize: quantize,
    pruneBlends: pruneBlends,
    /* 전처리 */
    removeBackground: removeBackground,
    decontaminate: decontaminate,
    removeSpecks: removeSpecks,
    buildSoft: buildSoft,
    /* 윤곽 */
    traceField: traceField,
    simplifyDP: simplifyDP,
    simplifyClosed: simplifyClosed,
    fitOpen: fitOpen,
    fitClosedLoop: fitClosedLoop,
    loopArea: loopArea,
    /* 파이프라인 */
    vectorize: vectorize,
    /* 내보내기 */
    buildSVG: buildSVG,
    buildEPS: buildEPS,
    buildPDF: buildPDF,
    byteLength: byteLength,
    _fmt: fmt
  };
});
