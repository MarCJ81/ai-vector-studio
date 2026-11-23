/* ============================================================
   optimize.js · SVG 결과 경량화 (의존성 없음, 브라우저·node 공용)
   ------------------------------------------------------------
   VTracer 는 색 레이어마다 <g><path/></g> 한 덩어리를 만든다.
   같은 색 레이어가 겹치지 않으면 한 path 로 합칠 수 있고,
   그룹 래퍼·빈 path·중복 공백은 화면에 아무 영향 없이 지울 수 있다.
   좌표 소수 자릿수는 내보내기 옵션으로 줄인다(기본 2자리 유지).

   원칙
   - 그리기 결과가 달라질 수 있는 변형은 하지 않는다.
     (겹치는 같은 색 path 는 evenodd 구멍이 생길 수 있어 합치지 않는다)
   - 변형마다 줄어든 바이트를 세어 화면에 근거를 보여 준다.
   - 입력이 예상 형식이 아니면 그대로 돌려준다(무음 손상 금지).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SvgOptimize = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  function byteLength(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* 숫자 하나를 지정 소수 자릿수로 자른다. 소수점 뒤 0 은 지운다. */
  function roundNum(v, digits) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    var p = Math.pow(10, digits);
    var r = Math.round(n * p) / p;
    if (Object.is(r, -0)) r = 0;
    var s = r.toFixed(digits);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s === '' || s === '-' ? '0' : s;
  }

  /** path d 문자열의 모든 숫자를 자릿수에 맞춰 다시 쓴다. 명령·구분자는 유지. */
  function roundPathData(d, digits) {
    var src = String(d || '');
    if (!src) return '';
    var out = '';
    var i = 0;
    var numRe = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;
    while (i < src.length) {
      var ch = src[i];
      numRe.lastIndex = i;
      var m = numRe.exec(src);
      if (m && m.index === i) {
        out += roundNum(parseFloat(m[0]), digits);
        i += m[0].length;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  }

  /** d 에서 좌표만 뽑아 대략적인 경계 상자를 구한다(합치기 안전 판정용). */
  function pathBBox(d) {
    var nums = String(d || '').match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g);
    if (!nums) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // 절대 좌표 M/L/C 와 상대 명령이 섞여도 "감싸는 상자"로만 쓰므로
    // 모든 짝수/홀수 값을 넓게 잡는다(보수적: 실제보다 크게).
    for (var i = 0; i + 1 < nums.length; i += 2) {
      var x = Number(nums[i]), y = Number(nums[i + 1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function boxesOverlap(a, b, pad) {
    if (!a || !b) return true;                 // 판정 불가 → 합치지 않는다
    var p = pad || 0;
    return !(a.maxX + p < b.minX || b.maxX + p < a.minX || a.maxY + p < b.minY || b.maxY + p < a.minY);
  }

  function bboxArea(b) {
    if (!b) return 0;
    return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
  }

  /**
   * 레이어 목록 → 최적화된 레이어 목록.
   * layers: [{ hex, d }]
   * opts: { precision, mergeSameFill, dropTiny, tinyArea }
   */
  function optimizeLayers(layers, opts) {
    var o = opts || {};
    var precision = o.precision === undefined ? 2 : Math.max(0, Math.min(4, Number(o.precision)));
    var merge = o.mergeSameFill !== false;
    var dropTiny = o.dropTiny === true;
    var tinyArea = o.tinyArea === undefined ? 2 : Number(o.tinyArea);
    var list = [];
    var i;
    for (i = 0; i < (layers || []).length; i++) {
      var L = layers[i] || {};
      var d = roundPathData(L.d, precision).replace(/\s+/g, ' ').replace(/\s*([A-Za-z])\s*/g, '$1').replace(/\s?,\s?/g, ',').trim();
      if (!d || !/[0-9]/.test(d)) continue;
      var box = pathBBox(d);
      if (dropTiny && box && bboxArea(box) < tinyArea) continue;
      list.push({ hex: L.hex, d: d, box: box, merged: 0 });
    }

    if (merge) {
      // 겹치지 않는 같은 색은 한 path 로. (겹치면 evenodd 구멍 위험 → 그대로 둔다)
      var merged = [];
      for (i = 0; i < list.length; i++) {
        var cur = list[i];
        var hit = null;
        for (var j = 0; j < merged.length; j++) {
          var cand = merged[j];
          if (!cand.hex || cand.hex !== cur.hex) continue;
          if (!boxesOverlap(cand.box, cur.box, 0.5)) { hit = cand; break; }
        }
        if (hit) {
          hit.d = hit.d + ' ' + cur.d;
          hit.box = unionBox(hit.box, cur.box);
          hit.merged += 1;
        } else {
          merged.push(cur);
        }
      }
      list = merged;
    }
    return { layers: list, precision: precision };
  }

  function unionBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY)
    };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 원본 SVG 문자열에서 header/viewBox/title 을 그대로 살려 다시 조립한다. */
  function rebuild(svg, layers, opts) {
    var o = opts || {};
    var src = String(svg || '');
    var head = src.match(/<(svg)\b([^>]*)>/i);
    var title = src.match(/<title>([\s\S]*?)<\/title>/i);
    if (!head) return null;
    var open = '<svg' + head[2] + '>';
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(open);
    if (title) parts.push('<title>' + title[1] + '</title>');
    var groupWrap = o.group !== false;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var fill = L.hex ? 'fill="' + esc(L.hex) + '" ' : '';
      if (groupWrap) parts.push('<g id="c' + (i + 1) + '" ' + fill + 'fill-rule="evenodd"><path d="' + L.d + '"/></g>');
      else parts.push('<path ' + fill + 'd="' + L.d + '"/>');
    }
    parts.push('</svg>');
    return o.minify === false ? parts.join('\n') : parts.join('');
  }

  /**
   * SVG 문자열 → { svg, stats }
   * opts: { precision, mergeSameFill, dropTiny, group, minify }
   */
  function optimize(svg, opts) {
    var o = opts || {};
    var src = String(svg || '');
    var before = byteLength(src);
    var layers = parseLayers(src);
    if (!layers.length) {
      return { svg: src, stats: { before: before, after: before, saved: 0, savedPct: 0, layers: 0, merged: 0, precision: o.precision, changed: false } };
    }
    var res = optimizeLayers(layers, o);
    var out = rebuild(src, res.layers, o);
    if (!out) {
      return { svg: src, stats: { before: before, after: before, saved: 0, savedPct: 0, layers: layers.length, merged: 0, precision: o.precision, changed: false } };
    }
    var after = byteLength(out);
    var mergedTotal = 0;
    for (var i = 0; i < res.layers.length; i++) mergedTotal += res.layers[i].merged || 0;
    return {
      svg: out,
      stats: {
        before: before,
        after: after,
        saved: Math.max(0, before - after),
        savedPct: before ? Math.max(0, Math.round((1 - after / before) * 1000) / 10) : 0,
        layers: res.layers.length,
        sourceLayers: layers.length,
        merged: mergedTotal,
        precision: res.precision,
        changed: out !== src
      }
    };
  }

  /** buildSVG 출력에서 레이어를 읽는다. 형식이 다르면 빈 배열. */
  function parseLayers(svg) {
    var out = [];
    var src = String(svg || '');
    var re = /<g\b([^>]*)>\s*<path\b[^>]*\bd="([^"]*)"[^>]*\/?>\s*<\/g>/gi;
    var m;
    while ((m = re.exec(src))) {
      var attrs = m[1] || '';
      var fill = attrs.match(/fill="([^"]*)"/i);
      out.push({ hex: fill ? fill[1] : '', d: m[2] || '' });
    }
    if (out.length) return out;
    // 그룹 없이 path 만 있는 경우도 받아 준다.
    var re2 = /<path\b([^>]*)\bd="([^"]*)"[^>]*\/?>/gi;
    while ((m = re2.exec(src))) {
      var a2 = m[1] || '';
      var f2 = a2.match(/fill="([^"]*)"/i);
      out.push({ hex: f2 ? f2[1] : '', d: m[2] || '' });
    }
    return out;
  }

  return {
    VERSION: VERSION,
    byteLength: byteLength,
    roundNum: roundNum,
    roundPathData: roundPathData,
    pathBBox: pathBBox,
    optimizeLayers: optimizeLayers,
    parseLayers: parseLayers,
    optimize: optimize
  };
});
