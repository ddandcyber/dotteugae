# 도트뜨개 (Crochet Alpha) — 사이트 폴더

## 구조

| 주소 | 파일 | 내용 |
|---|---|---|
| `/` | `index.html` | 홈 (도구 소개, 예시, 가이드, 자주 묻는 질문) |
| `/pattern/` | `pattern/index.html` | 도안 만들기 (스타일은 `assets/pattern.css`, 스크립트는 `assets/pattern.js`) |
| `/counter/` | `counter/index.html` | 코수 세기 |
| `/examples/` | `examples/index.html` | 예시 도안 (`examples/img/`에 미리보기 PNG와 도안 파일 JSON) |
| `/guides/` | `guides/index.html` 외 2편 | 가이드 |
| `/about/` `/privacy/` `/credits/` | 각 폴더 `index.html` | 소개·문의, 개인정보처리방침, 폰트 출처 |
| `/en/` | `en/index.html` | 영어 홈 |
| `/en/pattern/` | `en/pattern/index.html` | 영어 도안 만들기 (`assets/pattern.css`, `assets/pattern.js`를 한국어판과 같이 씀) |
| — | `assets/` | 공통 스타일(site.css), 도안 만들기 스타일·스크립트(pattern.css, pattern.js), 아이콘, 미리보기 이미지(og.png), 폰트(fonts/) |
| — | `404.html` `robots.txt` `sitemap.xml` | 없는 페이지 안내, 검색엔진용 파일 |

폰트는 `assets/fonts/`에 따로 있어서, 도안 만들기에서 **고른 폰트만** 그때 내려받아요.

영어 페이지는 `/en/` 아래에 있어요. 한국어 페이지와 영어 페이지는 `<head>`의 `hreflang`으로 서로 짝을 이루고, 맨 위 메뉴의 EN / 한국어 링크로 오가요. 브라우저 언어에 따라 자동으로 옮기지는 않아요. 아직 영어판이 없는 페이지(코수 세기, 예시, 가이드, 소개, 개인정보, 폰트 출처)는 영어 메뉴에서 한국어 페이지로 연결돼요.

