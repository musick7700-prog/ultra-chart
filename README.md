# Ultra 차트

바이낸스 USDⓈ-M **BTCUSDT 무기한** 1분봉을 브라우저에서 보는 정적 차트입니다. 한국어 UI이고, 아이폰 홈 화면에 추가하면 **Ultra 차트**라는 이름으로 앱처럼 열립니다.

표시 전용입니다. API 키가 없고, 주문을 넣지 않으며, 거래소 계정에 로그인하지 않습니다. 화면에 나오는 매매와 손익은 받아 온 봉으로 계산한 종이 매매입니다.

사이트: https://musick7700-prog.github.io/ultra-chart/

## 시세

1. 브라우저가 먼저 `https://fapi.binance.com/fapi/v1/klines` 에서 BTCUSDT 무기한 1분봉을 받습니다. 응답이 거절되면 `https://fapi1.binance.com` 을 같은 방식으로 시도합니다. 봉에는 테이커 매수 수량이 들어 있습니다.
2. 지역 제한이나 CORS로 둘 다 실패하면, 같은 무기한 1분봉 공개 파일인 [data.binance.vision](https://data.binance.vision) 일별 zip으로 넘어갑니다. 이 파일도 테이커 매수 수량을 포함합니다. 보통 다음 날 생성되므로 오늘 구간은 비어 있을 수 있고, 그때는 화면 위 안내 배너가 이유를 알려 줍니다.
3. 그것까지 실패하면 같은 출처의 `/api/klines` 를 한 번만 더 시도합니다. GitHub Pages에는 이 경로가 없어서 그냥 넘어갑니다.
4. 모두 실패하면 차트를 비운 채 한국어 오류 배너를 냅니다.
5. 실시간 봉은 `wss://fstream.binance.com` 의 `btcusdt@kline_1m` 입니다.

## 페이지 배포

`main` 에 푸시하면 GitHub Actions(`.github/workflows/pages.yml`)가 `npm ci && npm run build` 를 실행합니다.

워크플로는 두 가지를 같이 합니다.

- `actions/configure-pages` (`enablement: true`)와 `actions/upload-pages-artifact`, `actions/deploy-pages` 로 GitHub Pages 배포를 시도합니다. `enablement` 는 `GITHUB_TOKEN` 이 아닌 관리자 토큰이 필요해서, 이 저장소의 Actions 토큰만으로는 Pages를 켜지 못하는 것이 정상입니다.
- 빌드 결과를 `gh-pages` 브랜치 루트에 올립니다 (`peaceiris/actions-gh-pages`, `GITHUB_TOKEN`).

**소유자가 선택할 설정:** 저장소 **Settings → Pages → Build and deployment → Source** 를 **Deploy from a branch** 로 두고, Branch 는 **`gh-pages`**, Folder 는 **`/ (root)`**, 그리고 **Save**.

Actions의 “Deploy to GitHub Pages” job이 실제로 성공한 뒤에만 Source 를 **GitHub Actions** 로 바꾸면 됩니다. 그 전까지는 **`gh-pages` / `/ (root)`** 가 맞는 선택입니다.

`gh-pages` job이 403으로 실패하면 **Settings → Actions → General → Workflow permissions** 를 **Read and write permissions** 로 두고 워크플로를 다시 실행한 다음, 위의 Pages 설정을 고릅니다.

## 로컬 빌드

```bash
npm ci
npm run build
npx vite preview
```

개발 서버와 미리보기는 `/ultra-chart/` 경로에서 열립니다.

## 오픈소스 고지

이 앱은 [funnest-charts](https://github.com/funnest-xyz/funnest-charts) (`@funnest/charts`, `@funnest/charts-ui` 0.6.21)를 사용합니다.

funnest-charts는 Apache License 2.0입니다. Copyright Funnest.

https://www.apache.org/licenses/LICENSE-2.0

차트 왼쪽 아래의 funnest attribution 배지는 켜 두었습니다. 끄지 마세요.

data.binance.vision 파일은 브라우저가 바이낸스에서 직접 받습니다. 이 저장소는 그 파일을 다시 배포하지 않습니다. 바이낸스 공개 데이터셋에는 별도의 이용 조건이 있을 수 있습니다.
