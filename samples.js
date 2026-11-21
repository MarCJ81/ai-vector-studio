/* ============================================================
   원탭 벡터 스튜디오 · samples.js
   ------------------------------------------------------------
   키·네트워크 없이 바로 테스트할 수 있는 내장 샘플 3종.
   모두 코드로 그린 고해상도 래스터(안티에일리어싱 포함)라,
   실제 AI 생성 이미지와 같은 조건에서 파이프라인을 시험할 수 있다.
     1) emblem   — 2색 심플 엠블럼
     2) badge    — 그라데이션 없는 다색 뱃지 (6색)
     3) mascot   — AI 스타일 마스코트 (잡티·부드러운 경계 포함)
   ============================================================ */
(function (root) {
  'use strict';

  var LIST = [
    { id: 'emblem', name: '심플 엠블럼', colors: 2, note: '2색 · 또렷한 선' },
    { id: 'badge', name: '다색 뱃지', colors: 6, note: '6색 · 면 분할' },
    { id: 'mascot', name: 'AI 마스코트', colors: 12, note: '12색 · 잡티 포함' }
  ];

  function rng(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function canvasOf(size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }

  /* ── 1. 심플 엠블럼 ─────────────────────────────────── */
  function drawEmblem(ctx, S) {
    var u = S / 1000, cx = 500 * u, cy = 500 * u;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, S, S);

    ctx.fillStyle = '#232B3A';
    // 바깥 원테
    ctx.beginPath(); ctx.arc(cx, cy, 400 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(cx, cy, 352 * u, 0, Math.PI * 2); ctx.fill();

    // 안쪽 얇은 링
    ctx.strokeStyle = '#232B3A';
    ctx.lineWidth = 10 * u;
    ctx.beginPath(); ctx.arc(cx, cy, 322 * u, 0, Math.PI * 2); ctx.stroke();

    // 산 + 해 마크
    ctx.fillStyle = '#232B3A';
    ctx.beginPath();
    ctx.moveTo(300 * u, 640 * u);
    ctx.lineTo(430 * u, 400 * u);
    ctx.lineTo(520 * u, 540 * u);
    ctx.lineTo(590 * u, 440 * u);
    ctx.lineTo(700 * u, 640 * u);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath(); ctx.arc(636 * u, 356 * u, 58 * u, 0, Math.PI * 2); ctx.fill();

    // 아래 두 줄 (글자 대신 막대)
    ctx.fillRect(360 * u, 706 * u, 280 * u, 22 * u);
    ctx.fillRect(406 * u, 754 * u, 188 * u, 16 * u);
  }

  /* ── 2. 다색 뱃지 ───────────────────────────────────── */
  function drawBadge(ctx, S) {
    var u = S / 1000, cx = 500 * u, cy = 460 * u;
    ctx.fillStyle = '#F6F2E9';
    ctx.fillRect(0, 0, S, S);

    function shield(r) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.bezierCurveTo(cx + r * 0.92, cy - r * 0.96, cx + r, cy - r * 0.1, cx + r * 0.98, cy + r * 0.2);
      ctx.bezierCurveTo(cx + r * 0.9, cy + r * 0.8, cx + r * 0.36, cy + r * 1.12, cx, cy + r * 1.26);
      ctx.bezierCurveTo(cx - r * 0.36, cy + r * 1.12, cx - r * 0.9, cy + r * 0.8, cx - r * 0.98, cy + r * 0.2);
      ctx.bezierCurveTo(cx - r, cy - r * 0.1, cx - r * 0.92, cy - r * 0.96, cx, cy - r);
      ctx.closePath();
    }

    // 그림자판
    ctx.fillStyle = '#243447';
    shield(330 * u); ctx.fill();
    // 금테
    ctx.fillStyle = '#D9A741';
    shield(300 * u); ctx.fill();
    // 안쪽 남색
    ctx.fillStyle = '#243447';
    shield(268 * u); ctx.fill();
    // 붉은 띠
    ctx.fillStyle = '#C0432C';
    ctx.save();
    shield(268 * u); ctx.clip();
    ctx.fillRect(0, 500 * u, S, 150 * u);
    ctx.restore();

    // 별
    ctx.fillStyle = '#F2D07A';
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var ang = -Math.PI / 2 + i * Math.PI / 5;
      var rr = (i % 2 === 0 ? 132 : 56) * u;
      var px = cx + Math.cos(ang) * rr, py = cy - 30 * u + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();

    // 리본
    ctx.fillStyle = '#F6F2E9';
    ctx.beginPath();
    ctx.moveTo(250 * u, 690 * u);
    ctx.lineTo(750 * u, 690 * u);
    ctx.lineTo(750 * u, 760 * u);
    ctx.lineTo(250 * u, 760 * u);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#C0432C';
    ctx.beginPath();
    ctx.moveTo(214 * u, 714 * u); ctx.lineTo(250 * u, 690 * u);
    ctx.lineTo(250 * u, 760 * u); ctx.lineTo(214 * u, 784 * u);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(786 * u, 714 * u); ctx.lineTo(750 * u, 690 * u);
    ctx.lineTo(750 * u, 760 * u); ctx.lineTo(786 * u, 784 * u);
    ctx.closePath(); ctx.fill();

    // 아래 점 3개
    ctx.fillStyle = '#3E8E7E';
    [400, 500, 600].forEach(function (x) {
      ctx.beginPath(); ctx.arc(x * u, 880 * u, 22 * u, 0, Math.PI * 2); ctx.fill();
    });
  }

  /* ── 3. AI 스타일 마스코트 ──────────────────────────── */
  function drawMascot(ctx, S) {
    var u = S / 1000, cx = 500 * u, cy = 520 * u;
    var rand = rng(20261121);

    ctx.fillStyle = '#FFF9EF';
    ctx.fillRect(0, 0, S, S);

    // 뒤 원
    ctx.fillStyle = '#DFEEE4';
    ctx.beginPath(); ctx.arc(cx, cy - 10 * u, 360 * u, 0, Math.PI * 2); ctx.fill();

    // 몸통
    ctx.fillStyle = '#79C3AE';
    ctx.beginPath(); ctx.ellipse(cx, cy + 40 * u, 268 * u, 238 * u, 0, 0, Math.PI * 2); ctx.fill();

    // 귀
    ctx.fillStyle = '#79C3AE';
    ctx.beginPath(); ctx.arc(cx - 190 * u, cy - 250 * u, 92 * u, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 190 * u, cy - 250 * u, 92 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#F3B7B0';
    ctx.beginPath(); ctx.arc(cx - 190 * u, cy - 250 * u, 50 * u, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 190 * u, cy - 250 * u, 50 * u, 0, Math.PI * 2); ctx.fill();

    // 배
    ctx.fillStyle = '#EAF6EA';
    ctx.beginPath(); ctx.ellipse(cx, cy + 110 * u, 150 * u, 128 * u, 0, 0, Math.PI * 2); ctx.fill();

    // 눈
    ctx.fillStyle = '#26403C';
    ctx.beginPath(); ctx.ellipse(cx - 96 * u, cy - 40 * u, 30 * u, 38 * u, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 96 * u, cy - 40 * u, 30 * u, 38 * u, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(cx - 105 * u, cy - 54 * u, 11 * u, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 87 * u, cy - 54 * u, 11 * u, 0, Math.PI * 2); ctx.fill();

    // 볼
    ctx.fillStyle = '#F5A8A0';
    ctx.beginPath(); ctx.ellipse(cx - 168 * u, cy + 34 * u, 44 * u, 30 * u, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 168 * u, cy + 34 * u, 44 * u, 30 * u, 0, 0, Math.PI * 2); ctx.fill();

    // 입
    ctx.strokeStyle = '#26403C';
    ctx.lineWidth = 9 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy + 34 * u, 42 * u, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    // 반짝이
    ctx.fillStyle = '#F2C866';
    [[200, 250], [810, 300], [770, 700], [230, 760]].forEach(function (p, i) {
      var r = (i % 2 ? 26 : 18) * u;
      ctx.beginPath();
      for (var k = 0; k < 8; k++) {
        var a = k * Math.PI / 4, rr = k % 2 ? r * 0.34 : r;
        var px = p[0] * u + Math.cos(a) * rr, py = p[1] * u + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    });

    // AI 원본 느낌의 미세 잡티 (잡티 제거 기능 확인용, 1~2px)
    var speckColors = ['#6FB5A2', '#8ACBB7', '#E2C08A', '#D8E7DC'];
    for (var i = 0; i < 110; i++) {
      var x = rand() * S, y = rand() * S;
      var w = (0.7 + rand() * 1.1) * u * 1.3;
      ctx.fillStyle = speckColors[i % speckColors.length];
      ctx.globalAlpha = 0.6 + rand() * 0.35;
      ctx.fillRect(x, y, w, w);
    }
    ctx.globalAlpha = 1;
  }

  var DRAW = { emblem: drawEmblem, badge: drawBadge, mascot: drawMascot };

  /** 새 캔버스에 샘플을 그려 반환 */
  function draw(id, size) {
    var c = canvasOf(size || 1000);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    (DRAW[id] || drawEmblem)(ctx, c.width);
    return c;
  }

  /** 파이프라인 입력용 ImageData */
  function imageData(id, size) {
    var c = draw(id, size || 1000);
    return c.getContext('2d').getImageData(0, 0, c.width, c.height);
  }

  root.VectorSamples = { list: LIST, draw: draw, imageData: imageData };
})(typeof self !== 'undefined' ? self : this);
