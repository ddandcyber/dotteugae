# 도트뜨개 (Crochet Alpha) — 사이트 폴더

## 구조

| 주소 | 파일 | 내용 |
|---|---|---|
| `/` | `index.html` | 홈 (도구 소개, 예시, 가이드, 자주 묻는 질문) |
| `/pattern/` | `pattern/index.html` | 도안 만들기 (스타일은 `assets/pattern.css`, 스크립트는 `assets/pattern.js`) |
| `/counter/` | `counter/index.html` | 코수 세기 |
| `/examples/` | `examples/index.html` | 예시 도안 (`examples/img/`에 미리보기 PNG와 도안 파일 JSON) |
| `/guides/` | `guides/index.html` 외 4편 | 가이드 |
| `/about/` `/privacy/` `/credits/` | 각 폴더 `index.html` | 소개·문의, 개인정보처리방침, 폰트 출처 |
| `/en/` | `en/index.html` | 영어 홈 |
| `/en/pattern/` | `en/pattern/index.html` | 영어 도안 만들기 (`assets/pattern.css`, `assets/pattern.js`를 한국어판과 같이 씀) |
| — | `assets/` | 공통 스타일(site.css), 도안 만들기 스타일·스크립트(pattern.css, pattern.js), 아이콘, 미리보기 이미지(og.png), 폰트(fonts/) |
| — | `404.html` `robots.txt` `sitemap.xml` | 없는 페이지 안내, 검색엔진용 파일 |

폰트는 `assets/fonts/`에 따로 있어서, 도안 만들기에서 **고른 폰트만** 그때 내려받아요.

영어 페이지는 `/en/` 아래에 있어요. 한국어 페이지와 영어 페이지는 `<head>`의 `hreflang`으로 서로 짝을 이루고, 맨 위 메뉴의 EN / 한국어 링크로 오가요. 브라우저 언어에 따라 자동으로 옮기지는 않아요. 아직 영어판이 없는 페이지(코수 세기, 예시, 가이드, 소개, 개인정보, 폰트 출처)는 영어 메뉴에서 한국어 페이지로 연결돼요.

도안 만들기의 **방안뜨기(filet) 탭**(캔버스 위 "도안 | 방안뜨기" 탭, '변형' 묶음의 "방안뜨기로 보기" 버튼으로도 들어가요)은 그린 도안을 방안뜨기 도안으로 바꿔 보여 줘요. 버전·색·뒤집기·이미지 저장은 방안뜨기 탭일 때만 작업창에 나와요. 보여 주는 것은 막힌 칸/빈 칸 미리보기, 기호도, 1단 시작 안내, 줄별 설명이고, PNG로 저장할 수도 있어요. 보기 전용이라 도안 데이터와 저장 내용은 바꾸지 않아요. 새로 쓰는 저장 이름은 '오늘은 보지 않기' 날짜를 담는 `crochet-filet-guide-hide` 하나뿐이에요. 공식에 쓰는 숫자(빈 칸 사슬 수, 기둥 높이, 단 바꿀 때 세우는 사슬)는 `assets/pattern.js`의 `FILET_VERSIONS` 표 한 곳에 있고, 계산은 `filetPlan` 함수가 해요.

