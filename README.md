# 도트뜨개 (Crochet Alpha) — 사이트 폴더

## 구조

| 주소 | 파일 | 내용 |
|---|---|---|
| `/` | `index.html` | 홈 (도구 소개, 예시, 가이드, 자주 묻는 질문) |
| `/pattern/` | `pattern/index.html` | 도안 만들기 |
| `/counter/` | `counter/index.html` | 코수 세기 |
| `/examples/` | `examples/index.html` | 예시 도안 (`examples/img/`에 미리보기 PNG와 도안 파일 JSON) |
| `/guides/` | `guides/index.html` 외 2편 | 가이드 |
| `/about/` `/privacy/` `/credits/` | 각 폴더 `index.html` | 소개·문의, 개인정보처리방침, 폰트 출처 |
| — | `assets/` | 공통 스타일(site.css), 아이콘, 미리보기 이미지(og.png), 폰트(fonts/) |
| — | `404.html` `robots.txt` `sitemap.xml` | 없는 페이지 안내, 검색엔진용 파일 |

폰트는 `assets/fonts/`에 따로 있어서, 도안 만들기에서 **고른 폰트만** 그때 내려받아요.

## 올리기 전 체크

1. **도메인**: https://crochetalpha.com 으로 적용 완료
2. **이메일**: hello@crochetalpha.com 으로 적용 완료 (Cloudflare Email Routing에서 이 주소를 만들어야 메일이 와요)
3. **개인정보처리방침 시행일**: 2026년 11월 3일로 적어둠 (실제 공개일이 다르면 수정)
4. **[직접 추가] 메모**: 소개 글, 가이드의 경험담·사진, 예시 완성작 사진 자리는 화면에 안 보이는 메모(`<!-- [직접 추가] ... -->`)로 남겨둠. 파일에서 "직접 추가"로 찾아 채우기

## Cloudflare에 올리기

1. Cloudflare 대시보드의 Workers & Pages에서 새 프로젝트를 만들고, 파일 직접 업로드로 이 폴더를 통째로 올리기 (메뉴 이름은 바뀔 수 있어요)
2. 프로젝트 설정의 사용자 지정 도메인에서 구매한 도메인 연결 (HTTPS는 자동)
3. Google Search Console에 사이트 등록 → `sitemap.xml` 제출

## 애드센스

승인 후 받은 코드를 각 페이지 `<head>`에 넣고, 사이트 맨 위에 `ads.txt` 파일을 추가해요. 도안 만들기 화면은 격자 가까이에 광고를 두면 칠하다가 잘못 누르기 쉬우니 피하세요.
