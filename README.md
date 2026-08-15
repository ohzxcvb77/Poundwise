# Poundwise

영국에서 생활하는 학생과 가족을 위한 GBP/KRW 이중 통화 가계부입니다. 앱을 열면 먼저 이메일 계정으로 로그인하며, 같은 계정으로 접속한 휴대폰·태블릿·컴퓨터에 거래와 예산이 자동 동기화됩니다. HTTPS로 배포하면 Android/iPhone 홈 화면에 설치되는 PWA로 동작합니다.

## 바로 사용하기

- 웹앱: [https://ohzxcvb77.github.io/Poundwise/](https://ohzxcvb77.github.io/Poundwise/)
- 소스 저장소: [https://github.com/ohzxcvb77/Poundwise](https://github.com/ohzxcvb77/Poundwise)

웹앱을 휴대폰 브라우저에서 연 뒤 아래 설치 방법을 따르면 홈 화면에 일반 앱처럼 추가할 수 있습니다.

## 주요 기능

- GBP 또는 KRW로 수입·지출 입력, 수정, 삭제
- 입력 금액과 전체 잔액을 GBP/KRW로 동시 표시
- 최신 GBP/KRW 환율 자동 적용 및 30분 간격 갱신
- 환율 API 실패 시 마지막 성공 환율 캐시 사용
- 캐시가 없을 때 수동 환율 입력 또는 임시 환율 사용
- 용돈일 기준/매월 1일 기준 예산 주기
- 목표 저축액 또는 저축률과 현재 저축 완료액 관리
- 오늘·이번 주 사용 가능액, 지출률, 저축 진행률 자동 계산
- 카테고리별 지출 도넛 차트와 거래 검색/필터
- CSV 내보내기와 불러오기
- 데스크톱, 태블릿, 모바일 반응형 화면
- Android/iPhone 홈 화면 설치와 오프라인 앱 셸
- 앱 진입 이메일 로그인과 계정별 로컬 캐시 분리
- 첫 로그인 시 개인 클라우드 가계부 자동 생성
- 같은 계정으로 로그인한 모든 기기의 거래·예산 동기화
- 8자리 초대 코드로 선택적인 가족 공유
- 가족 멤버 표시와 20초 간격/실시간 기기 동기화
- 오프라인 변경 보관 및 연결 복구 시 자동 병합
- Row Level Security로 가족 멤버만 공유 데이터 접근

기본 카테고리는 `Rent`, `Groceries`, `Transport`, `Eating Out`, `Shopping`, `Travel`, `Bills`, `Study`, `Health`, `Other`입니다.

## 실행 방법

앱 폴더에서 간단한 정적 웹 서버를 실행하는 방법을 권장합니다.

### VS Code

1. 이 폴더를 VS Code로 엽니다.
2. Live Server 확장을 사용해 `index.html`을 실행합니다.

### Node.js

프로젝트에 이미 정적 서버 도구가 있다면 다음처럼 실행할 수 있습니다.

```bash
npx serve .
```

표시된 로컬 주소를 브라우저에서 열면 됩니다. 로그인과 동기화를 사용하려면 아래 Supabase 설정을 먼저 완료해야 합니다. 앱 설치·오프라인 캐시는 HTTPS 또는 `localhost` 주소에서 동작합니다.

## 핸드폰에 앱으로 설치

PWA 설치에는 공개된 HTTPS 주소가 필요합니다. 현재 버전은 GitHub Pages의 [Poundwise 웹앱](https://ohzxcvb77.github.io/Poundwise/)에 배포됩니다. 별도 빌드 단계는 없습니다.

배포할 때 다음 파일이 모두 같은 폴더에 있어야 합니다.

```text
index.html
styles.css
app.js
cloud-sync.js
cloud-config.js
manifest.webmanifest
service-worker.js
app-icon.svg
app-icon-192.png
app-icon-512.png
```

### Android

1. Chrome에서 배포된 HTTPS 주소를 엽니다.
2. 앱의 `예산 및 공유 설정 → 내 데이터 → 핸드폰에 앱 설치`에서 `설치`를 누릅니다.
3. 설치 안내가 안 뜨면 Chrome 메뉴에서 `앱 설치` 또는 `홈 화면에 추가`를 선택합니다.

### iPhone/iPad

1. Safari에서 배포된 HTTPS 주소를 엽니다.
2. 하단 공유 버튼을 누릅니다.
3. `홈 화면에 추가`를 선택합니다.

설치 후에는 일반 앱처럼 전체 화면으로 열립니다. 앱 화면과 최근 정적 파일은 서비스 워커에 캐시되므로 인터넷이 잠시 끊겨도 로컬 거래를 계속 기록할 수 있습니다.

## 로그인·기기 동기화·가족 공유 설정

앱은 Supabase 이메일 인증과 데이터베이스를 사용합니다. 배포 파일에 프로젝트 URL과 브라우저용 공개 키를 설정하면 모든 사용자가 앱 진입 화면에서 로그인할 수 있습니다. 첫 로그인 시 계정 전용 `내 가계부` 공간이 자동 생성됩니다.

### 1. Supabase 프로젝트 준비

1. Supabase에서 새 프로젝트를 만듭니다.
2. Dashboard의 `SQL Editor`를 엽니다.
3. `supabase-schema.sql` 전체 내용을 붙여넣고 한 번 실행합니다.
4. Authentication의 Email/Password 로그인을 활성화합니다. 기본 설정에서는 가입 확인 이메일이 필요할 수 있습니다.
5. Authentication의 URL Configuration에서 Site URL을 실제 배포 주소로 설정하고, 같은 주소를 Redirect URLs에도 추가합니다.
6. 프로젝트의 Data API/Connect 화면에서 Project URL과 `Publishable key` 또는 레거시 `anon key`를 확인합니다.

`secret`, `service_role`, `sb_secret_...` 키는 브라우저에 절대 넣지 마세요. 이 키들은 모든 데이터 접근 권한을 가질 수 있습니다.

### 2. 앱에 연결 정보 입력

공개 웹앱은 배포 파일에 연결 정보를 미리 설정하는 방식을 권장합니다.

#### 배포 파일에 미리 설정

`cloud-config.js`를 수정하면 같은 배포 주소를 사용하는 모든 기기에서 별도 설정 없이 로그인할 수 있습니다.

```js
window.POUNDWISE_CLOUD_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabasePublishableKey: "sb_publishable_YOUR_KEY",
});
```

Publishable/anon key는 브라우저 배포용 공개 키이며, 실제 접근 권한은 `supabase-schema.sql`의 Row Level Security 정책이 제한합니다.

이미 로그인 서버가 연결된 앱에서는 `예산 및 공유 설정 → 계정 · 가족 공유 · 기기 동기화 → 클라우드 연결 설정`에서 현재 브라우저만 다른 Supabase 프로젝트로 바꿀 수도 있습니다.

### 3. 로그인과 가족 공유

개인 기기 동기화:

1. 앱 첫 화면에서 이메일 계정을 만들고 로그인합니다.
2. 초기 잔액·용돈일·예산·저축 목표를 설정합니다.
3. 다른 기기에서 같은 이메일 계정으로 로그인하면 기존 데이터가 자동으로 표시됩니다.

가족에게 공유하려는 사용자:

1. 설정 화면의 `가족 초대 코드`를 복사해 가족에게 전달합니다.
2. 가족은 자신의 계정으로 로그인합니다.
3. `다른 가족의 초대 코드로 참여`를 열고 코드와 표시 이름을 입력합니다.

참여가 완료되면 해당 가족 가계부가 현재 기기에 표시됩니다. 동기화는 거래 추가·수정·삭제 직후, 앱을 다시 열 때, 인터넷 연결이 복구될 때, 그리고 20초 간격으로 실행됩니다. 동시에 수정된 항목은 `updated_at`이 더 최근인 변경을 유지합니다. 삭제 내역도 tombstone으로 동기화되어 다른 기기에서 다시 나타나지 않습니다.

## 환율 API 설정

기본값은 무료 공개형 [Frankfurter v2 API](https://frankfurter.dev/)입니다.

```text
https://api.frankfurter.dev/v2/rate/GBP/KRW
```

- API 키가 필요하지 않습니다.
- 앱 시작 시 자동으로 최신 환율을 요청합니다.
- 자동 모드에서는 30분마다 다시 확인합니다.
- 성공 응답은 `poundwise_rate_cache_v1` 키로 로컬 저장됩니다.
- 요청 실패 시 마지막 성공 환율을 유지합니다.
- 성공 이력이 없으면 임시값을 표시하고 설정 화면에서 수동 환율을 적용할 수 있습니다.

다른 API를 사용하려면 `app.js` 상단의 `EXCHANGE_API_URL`과 `fetchExchangeRate()` 안의 응답 파싱 부분을 변경하세요. 정적 웹앱 코드에 유료 API 비밀 키를 직접 넣으면 브라우저에서 노출됩니다. 비밀 키가 필요한 API는 별도 서버나 서버리스 프록시에서 호출하는 방식을 권장합니다.

> 이 앱의 환율은 금융기관의 기준 환율 데이터에 맞춰 갱신되며, 실시간 거래용 호가가 아닙니다.

## 계산 기준

모든 계산의 기준 통화는 GBP입니다. KRW 거래는 현재 적용 중인 환율로 GBP 환산한 뒤 합산합니다.

```text
현재 총 잔액 = 초기 잔액 + 수입 합계 - 지출 합계
남은 저축 필요액 = max(0, 저축 목표 - 현재 주기 저축 완료액)
가용 잔액 = max(0, 현재 총 잔액 - 남은 저축 필요액)
오늘 권장 사용액 = 가용 잔액 / 다음 용돈일까지 남은 일수
이번 주 사용 가능액 = 오늘 권장 사용액 × min(7, 남은 일수)
현재 지출률 = 현재 주기 지출 / 주기 예산 × 100
저축 진행률 = 저축 완료액 / 저축 목표 × 100
```

용돈일 기준 주기는 다음 용돈일에서 한 달 전 날짜부터 계산합니다. 매월 기준 주기는 현재 달 1일부터 다음 달 1일 전까지입니다. 미래 날짜의 거래는 현재 잔액과 현재 주기 통계에 포함하지 않습니다.

## CSV 형식

내보내는 CSV의 열 순서는 다음과 같습니다.

```csv
id,type,amount,currency,date,category,memo
```

불러올 때 필수 열은 `type`, `amount`, `currency`, `date`입니다.

- `type`: `income`, `expense`, `수입`, `지출`
- `currency`: `GBP` 또는 `KRW`
- `date`: `YYYY-MM-DD`
- `category`: 기본 카테고리 중 하나, 없는 값은 `Other` 처리
- `memo`: 선택 사항

불러온 거래는 기존 거래에 추가됩니다. 형식이 잘못된 행은 건너뛰고, 정상적으로 불러온 건수를 화면에 표시합니다.

## 데이터 저장과 초기화

- 로그인 전 기존 앱 데이터: `localStorage`의 `poundwise_state_v1`
- 계정별 로컬 캐시: `poundwise_state_v1_account_<사용자 ID>`
- 현재 계정 캐시 위치: `poundwise_active_state_key_v1`
- 마지막 성공 환율: `localStorage`의 `poundwise_rate_cache_v1`
- 클라우드 연결 정보: `localStorage`의 `poundwise_cloud_config_v1`
- 로그인하면 거래·예산이 사용자가 설정한 Supabase 프로젝트로 동기화됩니다.
- 서로 다른 계정의 로컬 캐시는 분리되며, 데이터베이스에서는 RLS 정책으로 접근 권한을 제한합니다.
- 로그아웃하거나 클라우드 연결을 지워도 현재 기기의 로컬 데이터는 유지됩니다.

브라우저 사이트 데이터를 삭제하거나 시크릿 모드를 종료하면 저장 내용이 사라질 수 있습니다. 중요한 거래는 설정 화면에서 CSV로 주기적으로 백업하세요.

## 파일 구성

```text
index.html   화면 구조와 접근성 마크업
styles.css  대시보드 디자인과 반응형 레이아웃
app.js      상태 저장, 환율, 계산, 거래, CSV 기능
cloud-sync.js  계정, 가족 공유, 충돌 병합, PWA 설치 기능
cloud-config.js  배포 시 사용할 공개 Supabase 설정
supabase-schema.sql  공유 테이블, RPC, RLS 보안 정책
manifest.webmanifest  모바일 앱 설치 정보
service-worker.js  오프라인 앱 셸 캐시
app-icon-*.png  Android/iPhone 홈 화면 아이콘
README.md   실행 및 설정 안내
```
