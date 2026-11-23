/* ============================================================
   원탭 벡터 스튜디오 · app.js
   이미지 → 벡터 파이프라인 실행, 비교 뷰, 4종 내보내기.
   모든 처리는 브라우저 안에서 끝난다 (네트워크 요청 0).
   ============================================================ */
(function () {
  'use strict';

  var C = window.VectorCore;
  var $ = function (id) { return document.getElementById(id); };

  var PRESETS = {
    logo: { colors: 6, minArea: 2, simplify: 0.5 },
    illustration: { colors: 12, minArea: 8, simplify: 1.2 },
    light: { colors: 4, minArea: 24, simplify: 2.4 }
  };

  var DEFAULTS = {
    colors: 6, bgMode: 'edges', bgTol: 30, minArea: 2, simplify: 0.5,
    maxSide: 1200, digits: 2, cmyk: false, preset: 'logo',
    viewMode: 'side', zoom: 'fit', showPaths: false, plainBg: false
  };

  var S = {
    settings: Object.assign({}, DEFAULTS),
    source: null,        // ImageData
    sourceName: '',
    sampleId: null,
    result: null,
    out: { svg: '', eps: '', ai: '', pdf: '' },
    zoom: 1,
    busy: false,
    timer: null,
    lastRun: 0
  };

  /* ── 테마 · 투명도 설정 ─────────────────────────────── */
  function setTheme(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var btn = $('themeBtn');
    if (btn) {
      btn.setAttribute('aria-label', t === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
      btn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
    }
    try { localStorage.setItem('ovs.theme', t); } catch (e) { /* 저장소를 못 쓰는 환경 */ }
  }

  function syncTransparency() {
    var q = window.matchMedia ? window.matchMedia('(prefers-reduced-transparency: reduce)') : null;
    document.documentElement.setAttribute('data-transparency', q && q.matches ? 'reduce' : 'full');
  }

  /* ── 저장/복원 ─────────────────────────────────────── */
  function load() {
    try {
      var raw = localStorage.getItem('ovs.settings.v1');
      if (raw) Object.assign(S.settings, JSON.parse(raw));
    } catch (e) { /* 저장소를 못 쓰는 환경 */ }
  }
  function save() {
    try { localStorage.setItem('ovs.settings.v1', JSON.stringify(S.settings)); } catch (e) { /* noop */ }
  }

  /* ── UI 헬퍼 ───────────────────────────────────────── */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 2200);
  }
  function setStatus(text, kind) {
    var el = $('runState');
    el.textContent = text;
    el.className = 'status' + (kind ? ' is-' + kind : '');
  }
  function progress(on) { $('progress').classList.toggle('is-on', !!on); }
  function kb(n) {
    if (!n) return '–';
    return n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  }

  /* ── 이미지 로드 ───────────────────────────────────── */
  function imageDataFromSource(img, maxSide) {
    var w = img.width, h = img.height;
    var side = Math.max(w, h);
    var scale = side > maxSide ? maxSide / side : 1;
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  function acceptImageData(data, name, sampleId) {
    S.source = { width: data.width, height: data.height, data: data.data };
    S.sourceName = name || 'image.png';
    S.sampleId = sampleId || null;
    $('emptyState').style.display = 'none';
    renderOriginal();
    var base = (name || 'image').replace(/\.[a-z0-9]+$/i, '');
    if (!$('fileName').dataset.touched) $('fileName').value = slug(base);
    if (sampleId) {
      var meta = window.VectorSamples.list.filter(function (x) { return x.id === sampleId; })[0];
      if (meta) $('fileName').value = slug(meta.id + '-vector');
    }
    updateFileInfo();
    applyZoom();
    schedule(0);
  }

  function slug(s) {
    return String(s || 'vector').toLowerCase().replace(/[^a-z0-9가-힣\-_]+/g, '-').replace(/^-+|-+$/g, '') || 'vector';
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('이미지 파일이 아닙니다.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var data = imageDataFromSource(img, 2400);
        acceptImageData(data, file.name, null);
        toast(file.name + ' 불러옴');
      };
      img.onerror = function () { toast('이미지를 읽지 못했습니다.'); };
      img.src = reader.result;
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다.'); };
    reader.readAsDataURL(file);
  }

  function loadSample(id, applyPreset) {
    var data = window.VectorSamples.imageData(id, 1000);
    var meta = window.VectorSamples.list.filter(function (x) { return x.id === id; })[0];
    // 샘플을 '직접 고를 때만' 권장 색상 수를 적용한다 (새로고침 시 설정 보존)
    if (meta && applyPreset !== false) {
      S.settings.colors = meta.colors;
      document.querySelectorAll('#colorChips .chip').forEach(function (x) {
        x.classList.toggle('is-on', Number(x.dataset.colors) === Number(meta.colors));
      });
      save();
    }
    acceptImageData(data, id + '.png', id);
    Array.prototype.forEach.call(document.querySelectorAll('.sample'), function (b) {
      b.classList.toggle('is-on', b.dataset.sample === id);
    });
  }

  /* ── 파이프라인 ────────────────────────────────────── */
  function schedule(delay) {
    clearTimeout(S.timer);
    S.timer = setTimeout(run, delay == null ? 200 : delay);
  }

  function run() {
    if (!S.source || S.busy) return;
    S.busy = true;
    setStatus('분석 중', 'run');
    progress(true);
    // 상태 표시가 먼저 그려지도록 한 프레임 양보
    requestAnimationFrame(function () {
      setTimeout(doRun, 16);
    });
  }

  function doRun() {
    var t0 = performance.now();
    var st = S.settings;
    var res;
    try {
      var opts = {
        colors: st.colors,
        background: { mode: st.bgMode, tolerance: Number(st.bgTol) },
        minArea: Number(st.minArea),
        simplify: Number(st.simplify),
        cornerAngle: 72,
        digits: Number(st.digits),
        maxSide: Number(st.maxSide)
      };
      var P = window.PrecisionVector;
      res = (P && P.ready()) ? P.vectorize(S.source, opts)
        : C.vectorize(S.source, Object.assign({ supersample: 'auto' }, opts));
    } catch (err) {
      S.busy = false; progress(false);
      setStatus('오류');
      toast('변환 중 문제가 생겼습니다.');
      if (window.console) console.error(err);
      return;
    }

    S.result = res;
    S.out.svg = C.buildSVG(res, { title: 'vector artwork' });
    S.out.eps = C.buildEPS(res, { cmyk: st.cmyk, title: 'vector artwork' });
    S.out.pdf = C.buildPDF(res, { cmyk: st.cmyk, title: 'vector artwork' });
    S.out.ai = S.out.pdf;
    S.lastRun = Math.round(performance.now() - t0);

    renderVector();
    renderStats();
    renderPalette();
    renderSizes();
    updateFileInfo();
    S.busy = false;
    progress(false);
    setStatus('완료 · ' + S.lastRun + 'ms', 'done');
    S.runs = (S.runs || 0) + 1;
  }

  /* ── 렌더링 ────────────────────────────────────────── */
  function renderOriginal() {
    var cv = $('origCanvas');
    if (!S.source) return;
    cv.width = S.source.width;
    cv.height = S.source.height;
    var ctx = cv.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(S.source.data), S.source.width, S.source.height), 0, 0);
  }

  /** 같은 SVG를 두 번 넣을 때 id가 겹치지 않게 접두사를 붙인다(참조 url(#id)도 같이). */
  function uniqueIds(svg, prefix) {
    return String(svg || '')
      .replace(/\sid="([^"]+)"/g, function (m, id) { return ' id="' + prefix + '-' + id + '"'; })
      .replace(/url\(#([^\)]+)\)/g, function (m, id) { return 'url(#' + prefix + '-' + id + ')'; });
  }

  function renderVector() {
    var holder = $('vecHolder');
    holder.innerHTML = S.out.svg || '';
    $('overlayLayer').innerHTML = uniqueIds(S.out.svg, 'ov');
    var svg = holder.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (S.settings.showPaths) {
      decorate(svg);
      var ov = $('overlayLayer').querySelector('svg');
      if (ov) decorate(ov);
    }
  }

  /** 노드·조절점 표시 */
  function decorate(svg) {
    var NS = 'http://www.w3.org/2000/svg';
    var w = S.result.width, h = S.result.height;
    var layer = document.createElementNS(NS, 'g');
    layer.setAttribute('pointer-events', 'none');
    var r = Math.max(1.1, Math.min(w, h) / 400);
    Array.prototype.forEach.call(svg.querySelectorAll('path'), function (p, pi) {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#C4B5FD');
      p.setAttribute('stroke-width', String(Math.max(0.5, r * 0.35)));
      p.setAttribute('stroke-opacity', '0.9');
      var d = p.getAttribute('d') || '';
      var tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) || [];
      var i = 0, cmd = '';
      while (i < tokens.length) {
        var tk = tokens[i];
        if (/^[MLCZ]$/.test(tk)) { cmd = tk; i++; continue; }
        if (cmd === 'M' || cmd === 'L') {
          dot(layer, +tokens[i], +tokens[i + 1], r * 0.9, 'solid');
          i += 2;
        } else if (cmd === 'C') {
          dot(layer, +tokens[i], +tokens[i + 1], r * 0.55, 'hollow');
          dot(layer, +tokens[i + 2], +tokens[i + 3], r * 0.55, 'hollow');
          dot(layer, +tokens[i + 4], +tokens[i + 5], r * 0.9, 'solid');
          i += 6;
        } else i++;
      }
    });
    svg.appendChild(layer);

    function dot(parent, x, y, rr, kind) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(x));
      c.setAttribute('cy', String(y));
      c.setAttribute('r', String(rr));
      c.setAttribute('fill', kind === 'solid' ? '#34E0C8' : '#06070B');
      c.setAttribute('stroke', kind === 'solid' ? '#34E0C8' : '#C4B5FD');
      c.setAttribute('stroke-width', String(Math.max(0.4, rr * 0.45)));
      parent.appendChild(c);
    }
  }

  function renderStats() {
    var r = S.result;
    if (!r) return;
    $('stAnchors').textContent = r.stats.anchors.toLocaleString();
    $('stPaths').textContent = r.stats.loops.toLocaleString();
    $('stSize').innerHTML = kb(S.out.svg.length) + '';
    var uniq = {};
    for (var ci = 0; ci < r.layers.length; ci++) uniq[r.layers[ci].hex] = 1;
    $('stColors').textContent = Object.keys(uniq).length;
    var red = r.stats.reduction * 100;
    $('stReduction').innerHTML = (red >= 99.95 ? '99.9' : red.toFixed(1)) + '<small>%</small>';
    $('stTime').innerHTML = r.stats.ms + '<small>ms</small>';
    var eb = $('engineBadge');
    if (eb) {
      var vt = r.engine === 'vtracer';
      eb.textContent = vt
        ? '정밀 엔진 · VTracer WASM' + (r.stats.supersample > 1 ? ' · ' + r.stats.supersample + '× 슈퍼샘플' : '')
        : (r.fallback === 'vtracer-complex' ? '자체 엔진 · 복잡도 자동 전환' : '자체 엔진' + (r.supersample > 1 ? ' · ' + r.supersample + '×' : ''));
      eb.className = 'engine-badge' + (vt ? ' is-precise' : '');
      eb.title = vt
        ? 'VTracer ' + (r.engineVersion || '') + ' (MIT OR Apache-2.0) — 브라우저 안에서만 실행'
        : '내장 베지어 엔진 — 같은 브라우저 안에서 실행';
    }
  }

  function renderSizes() {
    document.querySelectorAll('[data-size]').forEach(function (el) {
      var k = el.dataset.size;
      el.textContent = kb(S.out[k] ? S.out[k].length : 0);
    });
  }

  function renderPalette() {
    if (!S.result) return;
    var seen = {}, html = '';
    S.result.layers.forEach(function (L) {
      if (seen[L.hex]) return;                      // 같은 색은 한 번만 (레이어는 도형 단위)
      seen[L.hex] = 1;
      html += '<span class="sw" style="background:' + L.hex + '" title="' + L.hex + ' · ' + L.anchors + ' 노드"></span>';
    });
    $('palette').innerHTML = html;
    $('palette2').innerHTML = html;
  }

  function updateFileInfo() {
    var el = $('fileInfo');
    if (!S.source) { el.textContent = '아직 이미지가 없습니다.'; return; }
    var r = S.result;
    var lines = [];
    lines.push('<b>' + (S.sourceName || 'image') + '</b>');
    lines.push('원본 ' + S.source.width + '×' + S.source.height + ' px');
    if (r) {
      lines.push('작업 ' + r.width + '×' + r.height + ' px');
      if (r.stats.removedBackground) lines.push('배경 ' + r.stats.removedBackground.toLocaleString() + ' px 제거');
      lines.push('잡티 ' + r.stats.removedSpecks + '개 흡수');
    }
    el.innerHTML = lines.join('<br>');
    var warn = '';
    if (r && r.stats.anchors > 8000) warn = '노드가 많은 편입니다 — 곡선 단순화를 오른쪽으로 옮기면 가벼워집니다.';
    else if (r && r.layers.length >= 10) warn = '색이 많아 파일이 커집니다. 인쇄용 로고라면 4~6색이 적당합니다.';
    var uniq2 = {};
    if (r) for (var ci2 = 0; ci2 < r.layers.length; ci2++) uniq2[r.layers[ci2].hex] = 1;
    $('bgInfo').innerHTML = (r
      ? '도형 ' + Object.keys(uniq2).length + '색 · 패스 ' + r.stats.loops + '개 · 앵커 ' + r.stats.anchors + '개'
      : '') + (warn ? '<br><span style="color:var(--warn)">' + warn + '</span>' : '');
  }

  /* ── 확대·보기 ─────────────────────────────────────── */
  function applyZoom() {
    if (!S.source) return;
    var w = S.result ? S.result.width : S.source.width;
    var h = S.result ? S.result.height : S.source.height;
    var z = S.zoom;
    if (S.settings.zoom === 'fit') {
      var pane = $('paneOrig');
      var availW = pane.clientWidth - 28;
      var availH = pane.clientHeight - 28;
      z = Math.min(availW / w, availH / h);
      z = Math.max(0.05, Math.min(z, 2));
    }
    S.zoom = z;
    // 확대해도 보던 지점을 유지한다
    var ratioX = 0.5, ratioY = 0.5;
    var po = $('paneOrig');
    if (po.scrollWidth > po.clientWidth + 2) ratioX = (po.scrollLeft + po.clientWidth / 2) / po.scrollWidth;
    if (po.scrollHeight > po.clientHeight + 2) ratioY = (po.scrollTop + po.clientHeight / 2) / po.scrollHeight;

    ['zoomOrig', 'zoomVec'].forEach(function (id) {
      var box = $(id);
      box.style.width = Math.round(w * z) + 'px';
      box.style.height = Math.round(h * z) + 'px';
    });
    var cv = $('origCanvas');
    cv.style.width = Math.round(w * z) + 'px';
    cv.style.height = Math.round(h * z) + 'px';

    ['paneOrig', 'paneVec'].forEach(function (id) {
      var p = $(id);
      p.scrollLeft = ratioX * p.scrollWidth - p.clientWidth / 2;
      p.scrollTop = ratioY * p.scrollHeight - p.clientHeight / 2;
    });
  }

  /** 두 패널의 스크롤을 동기화해 같은 지점을 비교하게 */
  function syncScroll() {
    var a = $('paneOrig'), b = $('paneVec');
    function follow(src, dst) {
      src.addEventListener('scroll', function () {
        if (Math.abs(dst.scrollLeft - src.scrollLeft) > 1) dst.scrollLeft = src.scrollLeft;
        if (Math.abs(dst.scrollTop - src.scrollTop) > 1) dst.scrollTop = src.scrollTop;
      }, { passive: true });
    }
    follow(a, b); follow(b, a);
  }

  function setViewMode(mode) {
    S.settings.viewMode = mode;
    save();
    document.querySelectorAll('#viewMode button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    });
    var cmp = $('compare');
    cmp.classList.toggle('is-overlay', mode !== 'side');
    $('paneVec').style.display = (mode === 'side') ? '' : (mode === 'vector' ? '' : 'none');
    $('paneOrig').style.display = (mode === 'vector') ? 'none' : '';
    $('overlayLayer').style.display = (mode === 'overlay') ? 'block' : 'none';
    if (mode === 'overlay') $('paneVec').style.display = 'none';
    applyZoom();
  }

  function setZoom(kind) {
    S.settings.zoom = kind;
    save();
    document.querySelectorAll('#zoomBtns button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.zoom === kind);
    });
    S.zoom = kind === 'fit' ? S.zoom : Number(kind);
    applyZoom();
  }

  /* ── 내보내기 ──────────────────────────────────────── */
  function download(kind) {
    if (!S.result) { toast('먼저 이미지를 넣어 주세요.'); return; }
    var name = slug($('fileName').value || 'vector');
    var map = {
      svg: { ext: 'svg', mime: 'image/svg+xml;charset=utf-8' },
      eps: { ext: 'eps', mime: 'application/postscript' },
      ai: { ext: 'ai', mime: 'application/pdf' },
      pdf: { ext: 'pdf', mime: 'application/pdf' }
    };
    var m = map[kind];
    if (!m || !S.out[kind]) return;
    if (kind !== 'svg' && S.settings.cmyk !== true) {
      // 값이 바뀌었을 수 있으니 현재 옵션으로 다시 만든다
    }
    var payload = S.out[kind];
    var blob = new Blob([payload], { type: m.mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name + '.' + m.ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast(name + '.' + m.ext + ' 저장');
    S.downloads = (S.downloads || []).concat([{ kind: kind, name: name + '.' + m.ext, bytes: blob.size }]);
  }

  /* ── 샘플 썸네일 ───────────────────────────────────── */
  function buildSamples() {
    var wrap = $('samples');
    wrap.innerHTML = '';
    window.VectorSamples.list.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample';
      b.dataset.sample = s.id;
      b.title = s.name + ' · ' + s.note;
      b.setAttribute('aria-label', s.name + ' 샘플 사용');
      var c = window.VectorSamples.draw(s.id, 160);
      c.setAttribute('aria-hidden', 'true');
      var label = document.createElement('span');
      label.textContent = s.name;
      b.appendChild(c);
      b.appendChild(label);
      b.addEventListener('click', function () { loadSample(s.id); });
      wrap.appendChild(b);
    });
  }

  /* ── 설정 위젯 ─────────────────────────────────────── */
  function syncControls() {
    var st = S.settings;
    $('bgMode').value = st.bgMode;
    $('bgTol').value = st.bgTol;
    $('bgTolVal').textContent = st.bgTol;
    $('minArea').value = st.minArea;
    $('minAreaVal').textContent = st.minArea + ' px²';
    $('simplify').value = st.simplify;
    $('simplifyVal').textContent = Number(st.simplify).toFixed(1);
    document.querySelectorAll('#presetSeg button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.preset === st.preset);
    });
    $('maxSide').value = String(st.maxSide);
    $('cmyk').checked = !!st.cmyk;
    $('showPaths').checked = !!st.showPaths;
    $('plainBg').checked = !!st.plainBg;
    document.querySelectorAll('#colorChips .chip').forEach(function (b) {
      b.classList.toggle('is-on', Number(b.dataset.colors) === Number(st.colors));
    });
    document.querySelectorAll('#digitSeg button').forEach(function (b) {
      b.classList.toggle('is-on', Number(b.dataset.digits) === Number(st.digits));
    });
    document.querySelectorAll('#viewMode button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === st.viewMode);
    });
    document.querySelectorAll('#zoomBtns button').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.zoom === String(st.zoom));
    });
    document.querySelectorAll('.pane').forEach(function (p) {
      p.classList.toggle('is-plain', !!st.plainBg);
    });
    setViewMode(st.viewMode);
  }

  function bind() {
    // 탭
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) {
          x.classList.toggle('is-on', x === t);
          x.setAttribute('aria-selected', x === t ? 'true' : 'false');
        });
        document.querySelectorAll('.view').forEach(function (v) {
          v.classList.toggle('is-on', v.id === 'view-' + t.dataset.tab);
        });
        if (t.dataset.tab === 'studio') applyZoom();
      });
    });

    // 테마 — 기본은 다크 글래스, 라이트는 선택 옵션
    $('themeBtn').addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') !== 'light';
      setTheme(dark ? 'light' : 'dark');
    });

    // 업로드
    var drop = $('drop');
    drop.addEventListener('click', function () { $('fileInput').click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
    });
    $('fileInput').addEventListener('change', function (e) {
      loadFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      loadFile(f);
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (e.target.closest && e.target.closest('#drop')) return;
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    // 배경
    $('bgMode').addEventListener('change', function (e) { S.settings.bgMode = e.target.value; save(); schedule(); });
    $('bgTol').addEventListener('input', function (e) {
      S.settings.bgTol = Number(e.target.value); $('bgTolVal').textContent = e.target.value; save(); schedule();
    });

    // 색상
    document.querySelectorAll('#colorChips .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        S.settings.preset = 'custom';
        document.querySelectorAll('#presetSeg button').forEach(function (x) { x.classList.toggle('is-on', false); });
        S.settings.colors = Number(b.dataset.colors);
        document.querySelectorAll('#colorChips .chip').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        save(); schedule();
      });
    });

    // 잡티·정밀도
    $('minArea').addEventListener('input', function (e) {
      S.settings.preset = 'custom';
      document.querySelectorAll('#presetSeg button').forEach(function (x) { x.classList.toggle('is-on', false); });
      S.settings.minArea = Number(e.target.value);
      $('minAreaVal').textContent = e.target.value + ' px²';
      save(); schedule();
    });
    document.querySelectorAll('#presetSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = PRESETS[b.dataset.preset];
        if (!p) return;
        S.settings.preset = b.dataset.preset;
        S.settings.colors = p.colors;
        S.settings.minArea = p.minArea;
        S.settings.simplify = p.simplify;
        save(); syncControls(); schedule(0);
      });
    });
    $('simplify').addEventListener('input', function (e) {
      S.settings.preset = 'custom';
      document.querySelectorAll('#presetSeg button').forEach(function (x) { x.classList.toggle('is-on', false); });
      S.settings.simplify = Number(e.target.value);
      $('simplifyVal').textContent = Number(e.target.value).toFixed(1);
      $('simplifyHint').innerHTML = Number(e.target.value) < 0.7
        ? '지금은 <em>초정밀</em> — 노드가 많고 용량이 큽니다.'
        : (Number(e.target.value) > 1.8
          ? '지금은 <em>경량</em> — 매끈하지만 작은 굴곡이 사라집니다.'
          : '정밀도와 용량의 균형 구간입니다.');
      save(); schedule();
    });
    $('maxSide').addEventListener('change', function (e) { S.settings.maxSide = Number(e.target.value); save(); schedule(); });

    // 보기
    document.querySelectorAll('#viewMode button').forEach(function (b) {
      b.addEventListener('click', function () { setViewMode(b.dataset.mode); });
    });
    document.querySelectorAll('#zoomBtns button').forEach(function (b) {
      b.addEventListener('click', function () { setZoom(b.dataset.zoom); });
    });
    $('showPaths').addEventListener('change', function (e) {
      S.settings.showPaths = e.target.checked; save(); renderVector();
    });
    $('plainBg').addEventListener('change', function (e) {
      S.settings.plainBg = e.target.checked; save();
      document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('is-plain', e.target.checked); });
    });

    // 내보내기
    document.querySelectorAll('.fmt').forEach(function (b) {
      b.addEventListener('click', function () { download(b.dataset.fmt); });
    });
    $('quickSvg').addEventListener('click', function () { download('svg'); });
    $('fileName').addEventListener('input', function (e) { e.target.dataset.touched = '1'; });
    document.querySelectorAll('#digitSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        S.settings.digits = Number(b.dataset.digits);
        document.querySelectorAll('#digitSeg button').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        save(); schedule();
      });
    });
    $('cmyk').addEventListener('change', function (e) { S.settings.cmyk = e.target.checked; save(); schedule(0); });

    // 리사이즈
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(applyZoom, 120);
    });
  }

  /* ── 시작 ──────────────────────────────────────────── */
  function init() {
    var th = 'dark';
    try { th = localStorage.getItem('ovs.theme') === 'light' ? 'light' : 'dark'; } catch (e) { /* noop */ }
    setTheme(th);
    syncTransparency();
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-reduced-transparency: reduce)');
      if (mq.addEventListener) mq.addEventListener('change', syncTransparency);
      else if (mq.addListener) mq.addListener(syncTransparency);
    }
    load();
    buildSamples();
    bind();
    syncScroll();
    syncControls();
    renderOriginal();
    // 첫 화면: 엠블럼 샘플로 바로 결과를 보여 준다 (저장된 설정은 유지)
    loadSample('emblem', false);
    // 정밀 엔진(VTracer WASM)은 900KB 라서 첫 페인트 뒤에 조용히 불러온다
    if (window.PrecisionVector) {
      window.PrecisionVector.load().then(function (api) {
        if (api && S.source) schedule(0);
        var eb = $('engineBadge');
        if (eb && !api) { eb.textContent = '자체 엔진 (정밀 엔진 로드 실패)'; }
      });
    }
  }

  window.__studio = {
    get state() { return S; },
    get result() { return S.result; },
    get runs() { return S.runs || 0; },
    get zoom() { return S.zoom; },
    runNow: function () { clearTimeout(S.timer); run(); },
    loadSample: loadSample,
    setSource: function (data, name) { acceptImageData(data, name, null); },
    download: download,
    settings: function () { return S.settings; },
    engine: function () { return S.result ? S.result.engine : null; },
    preset: function (name) {
      var p = PRESETS[name];
      if (!p) return;
      S.settings.preset = name;
      S.settings.colors = p.colors;
      S.settings.minArea = p.minArea;
      S.settings.simplify = p.simplify;
      save(); syncControls(); schedule(0);
    },
    ready: true
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
