# 서드파티 고지

## VTracer (visioncortex)
- 원본: https://github.com/visioncortex/vtracer
- npm: @visioncortex/vtracer 1.0.0-alpha.4 (WebAssembly 빌드)
- 라이선스: **MIT OR Apache-2.0**
- 사용 위치: `engine/vtracer-engine.js` (wasm-bindgen 글루, 로더만 수정),
  `engine/vtracer-data.js` (wasm 바이너리 base64 인라인)
- 저작권: Copyright (c) VisionCortex contributors

MIT 라이선스 전문은 https://opensource.org/licenses/MIT ,
Apache-2.0 전문은 https://www.apache.org/licenses/LICENSE-2.0 를 참고하세요.

이 앱은 위 엔진을 브라우저 안에서만 실행하며, 이미지나 결과를 외부로 전송하지 않습니다.
