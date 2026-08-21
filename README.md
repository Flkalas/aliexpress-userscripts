# AliExpress Userscripts

AliExpress용 Tampermonkey 유저스크립트 모음입니다. GitHub raw URL로 설치하면 Tampermonkey가 `@updateURL`을 통해 자동 업데이트합니다.

## 사전 요구사항

- [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox 등)

## 설치

아래 링크를 열면 Tampermonkey 설치 화면이 뜹니다.

| 스크립트 | 설명 | 설치 |
|----------|------|------|
| **AliExpress Reopener** | 상품 페이지에서 코인샵·꽁돈대첩 등 채널별 URL을 새 탭으로 엽니다 | [Install](https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-reopener.user.js) |
| **배송비 포함 가격 표시기** | 수량·배송비 변경을 반영해 총액·개당 가격을 표시합니다 | [Install](https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-total-price.user.js) |
| **Tracking Number Collector** | 주문 상세에서 송장번호를 모아 복사합니다 | [Install](https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress_tracking_collector.user.js) |

## 업데이트

스크립트마다 `@updateURL` / `@downloadURL`이 이 저장소의 raw 파일을 가리킵니다. 버전(`@version`)을 올리고 push하면 Tampermonkey가 주기적으로 새 버전을 받습니다.

수동 확인: Tampermonkey 대시보드 → 해당 스크립트 → **업데이트 확인**.

## 파일

- `aliexpress-reopener.user.js`
- `aliexpress-total-price.user.js`
- `aliexpress_tracking_collector.user.js`

## 라이선스

개인·지인 공유용으로 자유롭게 사용하세요.
