# Error to Test

SDK에서 내보낸 브라우저 오류 로그 또는 **직접 입력한 오류 메시지·스택**을 분석해 반복 오류 묶음과 회귀 TC 초안으로 만듭니다. 모델이나 수집 서버 없이 로컬에서 사용하며, Flow QA 형식으로 내보냅니다.

[English](README.md)

```sh
npm install -g @ihyeon/error-to-test
error-to-test --version
error-to-test analyze --error "TypeError: item is undefined" --page /items --out ./new-result
```

JavaScript API는 `npm install @ihyeon/error-to-test`로 설치합니다. [배포·검증 안내](docs/releases.md)에서 자동 게시 방식과 검증 범위를 확인할 수 있습니다.

Node.js 24 계열의 24.22.1 이상 또는 Node.js 26.12.1 이상이 필요합니다. [2026년 10월 보안 업데이트](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)를 반영한 최소 버전입니다. nvm을 사용한다면 현재 폴더에서 다음을 실행하세요.

```sh
nvm install
nvm use
```

이후 `npm ci`, `npm run check`를 실행한 뒤 사용하세요. Node.js 런타임은 별도로 설치하거나 업데이트해야 합니다. `npm install`은 런타임을 업데이트하지 않으며, npm은 `engine-strict`를 켜지 않은 경우 지원하지 않는 `engines` 버전에 경고만 표시합니다.

샘플은 `npm run demo`로 실행합니다. 매번 새 `.error-to-test/run-*` 폴더에 결과를 저장하고 보고서 경로를 출력합니다.

```sh
# SDK 없이 오류 하나를 직접 입력
node bin/error-to-test.mjs analyze --error "TypeError: item is undefined" --page /items --runtime browser --reproduce "View item 버튼 클릭" --expected "빈 상태 안내 표시" --expected-source "사용자가 설명한 기대 동작" --out .error-to-test/pasted

# 기존 오류 텍스트 파일 입력
node bin/error-to-test.mjs analyze --input examples/error.txt --page /items --runtime browser --out .error-to-test/text

# SDK JSON + 확인한 화면 계약으로 TC 생성
node bin/error-to-test.mjs analyze --input examples/errors.json --profile examples/profile.json --out .error-to-test/example
```

결과는 `analysis.json`, `report.md`, `flows/error-to-test.md`, `cases/error-to-test.json`, `provenance.json`입니다. 선택된 TC 후보가 없으면 suite를 만들지 않습니다. 출력 폴더는 매번 새 경로를 지정해야 합니다.

`--min-count N`으로 입력에 N건 이상 있는 오류 묶음만 TC 후보로 만들 수 있습니다. 범위는 1~10,000이며 기본값은 1입니다. 중복 제거·날짜 필터 적용 후 건수를 기준으로 고르고, `--top`은 그중 순위가 높은 묶음 수를 제한합니다. 기준 미만의 묶음도 `analysis.json`과 `report.md`에 남으며, 제외가 발생하면 보고서에 선택 기준을 표시합니다. 이 건수는 입력에 포함된 수집 이벤트·제출 보고서 수입니다.

```sh
error-to-test analyze --input errors.json --min-count 3 --top 10 --out ./recurring-errors
```

JavaScript API에서는 `analyzeErrors(content, { minCount: 3, top: 10 })`으로 같은 기준을 적용합니다.

`--input`을 반복하면 **여러 로그 파일을 함께 분석**할 수 있습니다.

```sh
error-to-test analyze --input morning.json --input afternoon.json --min-count 3 --top 10 --out ./combined
error-to-test verify ./combined --input morning.json --input afternoon.json
```

최대 50개 파일, 합산 10 MiB·원본 10,000건까지 받습니다. 중복도 한도에 포함합니다. SDK JSON 내보내기·배열끼리, 수동 JSON끼리, 텍스트끼리, 같은 종류의 JSONL끼리처럼 같은 입력 형식끼리 합칩니다. 텍스트는 파일 하나가 보고서 한 건이며, `--format`과 메타데이터·필터는 모든 파일에 적용합니다. 표준 입력(`--input -`)은 `analyze`에서 단독으로 사용하고, `verify`에는 원본 파일을 지정하세요.

파일과 표준 입력은 올바른 UTF-8이어야 합니다. 잘못된 바이트가 같은 대체 문자로 변환되어 원본 변경을 놓치지 않도록 해시 계산 전에 잘못된 인코딩을 거부합니다.

파일 전체에서 프로젝트·레코드 ID 중복을 먼저 검사한 뒤 필터·그룹 순위·TC 선택을 적용합니다. 동일한 레코드는 한 번만 세며, 같은 ID의 원본 내용이 다르면 정제 후 같아 보이거나 필터로 제외될 데이터여도 거부합니다. 하나라도 부분 내보내기이면 전체 결과에도 부분 입력으로 표시합니다. 건수는 제공한 로그 기준이며 실제 발생률을 의미하지 않습니다.

여러 파일의 원본 SHA-256과 UTF-8 바이트 수를 입력 순서대로 `analysis.source.inputs`와 보고서에 남깁니다. 파일명과 원문은 저장하지 않습니다. `source.sha256`은 `JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs })`의 SHA-256이며, 각 항목은 `{ sha256, byteLength }` 순서입니다. 이 목록도 분석 해시로 검증합니다. 원본 확인에는 BOM·공백까지 동일한 모든 파일을 같은 순서로 지정해야 합니다. 단일 입력의 기존 바이트 해시와 결과 형식은 유지합니다.

API에서도 `analyzeErrors([firstContent, secondContent], options)`, `parseInput([firstContent, secondContent], options)`, `await analyzeWithBaseline([firstContent, secondContent], baselineDirectory, options)`으로 사용합니다. 원본 검증은 `await verifyBundle(directory, { input: [firstContent, secondContent] })`입니다. 원소 하나의 배열은 문자열 하나와 동일합니다. 프로필 보완·이전 분석 대비 선택에도 같은 입력 순서를 유지하고, 기존 맥락 질문과 검토 조건을 적용합니다.

한 줄에 오류 한 건을 저장한 **JSONL 로그**는 `--format jsonl`로 분석합니다.

```sh
error-to-test analyze --input errors.jsonl --format jsonl --out ./jsonl-analysis
error-to-test analyze --input morning.jsonl --input afternoon.jsonl --format jsonl --min-count 3 --out ./combined-jsonl
cat errors.jsonl | error-to-test analyze --input - --format jsonl --out ./piped-jsonl
error-to-test verify ./jsonl-analysis --input errors.jsonl
```

각 줄은 `schemaVersion: 1`인 완전한 SDK 이벤트 객체이거나, `schemaVersion` 없이 `message`를 필수로 가진 수동 오류 객체입니다. 한 파일과 함께 분석할 여러 파일에서 두 종류를 섞을 수 없습니다. 수동 오류는 다음처럼 작성합니다.

```jsonl
{"id":"first","message":"TypeError: item is undefined","page":"/items","runtime":"browser"}
{"id":"second","message":"TypeError: item is undefined","page":"/items","runtime":"browser"}
```

[JSONL 예제](examples/manual.jsonl)는 `node bin/error-to-test.mjs analyze --input examples/manual.jsonl --format jsonl --min-count 2`로 실행합니다. 반복된 묶음 하나를 TC 대상으로 선택하고 전체 두 묶음을 남깁니다. 기대 결과나 실행할 assertion은 추측하지 않습니다.

LF·CRLF, 빈 줄, 문자열 안의 이스케이프된 줄바꿈과 파일 맨 앞의 BOM 하나를 지원합니다. 각 유효 줄은 완전한 JSON 객체 하나여야 합니다. 배열·내보내기 래퍼(`events`/`errors`)·줄별 `partial` 정보·알 수 없는 스키마는 거부합니다. 잘못된 줄은 건너뛰지 않고 1부터 시작하는 입력 파일 번호·실제 줄 번호로 알리며, 오류 원문은 진단 메시지에 넣지 않습니다. JSONL 자동 감지는 하지 않으므로 `--format jsonl`을 지정하세요. 기존 `auto`·`json`·`text` 동작은 유지합니다.

수집 범위는 `browser-error-jsonl`의 수집 이벤트 또는 `manual-jsonl`의 제출 보고서로 기록합니다. JSONL에는 내보내기의 부분 수집 정보가 없으므로 `partial: false`는 표시가 제공되지 않았다는 의미이며, 수집 완전성·보존 범위 미상 경고를 남깁니다. 완전한 수집을 뜻하지 않습니다. 기존 합산 한도·중복 제거·필터·원본 바이트 해시·프로필·검토 조건을 적용하고, 빈 줄은 건수에 넣지 않습니다.

API는 `analyzeErrors(content, { format: 'jsonl' })`이며 여러 파일의 문자열 배열도 지원합니다. 같은 건수 기준의 JSON·JSONL 번들은 `compare`와 `--baseline`으로 연결하며 형식 차이 경고를 유지합니다. 수집 이벤트와 제출 보고서는 비교할 수 없습니다. 기존 0.1.x 번들은 계속 읽을 수 있고, JSONL 번들은 0.2.0 이상이 필요합니다.

두 분석 결과는 `compare`로 비교할 수 있습니다. 릴리스가 바뀐 뒤 어떤 오류 서명이 다시 관측됐는지 확인할 때 사용합니다.

```sh
error-to-test analyze --input before-errors.json --release r1 --out ./before
error-to-test analyze --input current-errors.json --release r2 --out ./current
error-to-test compare ./before ./current
error-to-test compare ./before ./current --format json --out ./comparison.json
```

현재에만 있는 서명(`only-current`), 양쪽에 있는 서명(`both`), 이전에만 있는 서명(`only-baseline`)으로 나누고 제공된 로그 건수와 증감을 보여줍니다. 릴리스만 제외하고 프로젝트·환경·실행 환경·오류 유형·페이지 경로·전체 오류 서명이 일치해야 합니다. 메시지나 소스 위치가 바뀌면 별도 서명이며, 비슷한 문장을 같은 원인으로 추정하지 않습니다.

TC 생성 대상에서 제외된 묶음도 모두 비교합니다. 한쪽에 여러 릴리스가 있으면 같은 비교 키의 건수를 합산하고 원래 묶음 ID·릴리스 목록을 남깁니다. 단일 릴리스끼리 비교하려면 먼저 `analyze --release`로 범위를 정하세요. 페이지 조회 수는 합산하지 않습니다.

이전에만 관측됐다는 표시가 수정 완료를 의미하지 않습니다. 건수는 입력에 포함된 이벤트·보고서 수이며, 발생률이나 영향 사용자 수가 아닙니다. 양쪽의 부분 내보내기·기간·필터·수집 범위와 경고도 표시합니다. 수집 이벤트 건수와 수동 제출 보고서 건수의 비교는 거부합니다. 수동 JSON과 텍스트는 같은 제출 보고서 기준으로 비교하되 형식 차이를 알립니다.

양쪽 번들을 검증한 뒤 읽으며 원래 산출물·TC 상태·검토 조건·연결 결과는 수정하지 않습니다. 기본 출력은 Markdown이고, `--format json`은 `error-to-test/comparison-1`을 반환합니다. `--out`은 양쪽 번들의 `results` 폴더 밖에 있는 새 파일만 허용합니다. API는 `compareBundles()`와 `renderComparison()`입니다.

CI에서는 `--max-new N`으로 **현재에만 있는 오류 서명의 허용 개수**를 정할 수 있습니다.

```sh
error-to-test compare ./before ./current --max-new 0
error-to-test compare ./before ./current --max-new 2 --format json --out ./comparison.json
```

0~10,000의 십진 정수를 받습니다. TC 생성에서 제외된 묶음을 포함한 전체 비교 결과의 `only-current` 서명 수를 기준으로 합니다. 릴리스만 다른 동일 비교 키는 한 번 세며, 로그 건수나 건수 증가는 한도에 포함하지 않습니다.

| 종료 코드 | 의미 |
| --- | --- |
| `0` | 비교 성공, 한도 이내 또는 한도 옵션 미사용 |
| `1` | 잘못된 옵션·입력 형식 불일치·번들 변조·출력 오류 |
| `2` | 비교 성공, 현재에만 있는 서명 수가 한도 초과 |

한도를 넘겨도 전체 비교 보고서를 출력하거나 저장하므로 CI에서 검토 자료로 남길 수 있습니다. 숫자로 된 통과·실패 요약은 stderr에 쓰고, JSON stdout은 기존 `error-to-test/comparison-1` 형식을 유지합니다. 출력 오류는 코드 1로 처리하고 기존 파일을 보존합니다. 옵션을 생략하면 기존 비교 동작을 유지하며, `--max-new`는 `compare`에서만 사용할 수 있습니다.

프로젝트·환경·기간·수집 범위를 맞춘 분석을 기준으로 사용하세요. 부분 내보내기와 수집 범위 경고는 보고서에 남습니다. 이 값은 제공한 이전 분석에 없던 서명 수이며 실제 유입 시점이나 회귀 원인을 확정하지 않습니다. TC 실행·검토 상태는 변경하지 않습니다. API에서는 `comparison.counts['only-current']`로 같은 기준을 적용할 수 있습니다.

`analyze --baseline`을 쓰면 **이전 분석에서 관측되지 않은 서명만 골라 TC를 생성**할 수 있습니다.

```sh
error-to-test analyze --input before-errors.json --out ./before
error-to-test analyze --input current-errors.json --baseline ./before --min-count 3 --top 10 --out ./new-signature-tcs
error-to-test init-profile ./new-signature-tcs --out ./new-signature-profile.json
# 확인한 요구사항·준비 조건·동작·assertion으로 프로필 수정
error-to-test analyze --input current-errors.json --baseline ./before --min-count 3 --top 10 --profile ./new-signature-profile.json --out ./reviewed-new-signatures
```

`compare`와 같은 기준으로 릴리스만 제외한 전체 서명을 비교합니다. 이전 분석에서 TC 생성 대상이 아니었던 묶음도 비교에 포함합니다. 이전에 없던 현재 묶음을 먼저 고른 뒤 `--min-count`, `--top`을 적용하므로 순위가 높은 기존 오류 때문에 새 서명의 TC가 밀려나지 않습니다. 최소 건수는 현재의 각 묶음별로 적용하며 서로 다른 릴리스의 건수를 합치지 않습니다. 현재의 전체 묶음·원본 해시·수집 범위는 그대로 남습니다. 선택할 후보가 없으면 suite 없이 정상 번들을 만듭니다.

`analysis.json`의 `selection`과 보고서에 선택 방식(`only-current`), 이전 입력·검증된 분석 파일의 SHA-256, 이전 수집 범위, 선택·제외 묶음 수를 기록합니다. 이 정보도 새 번들의 분석 해시로 검증됩니다. 이전 번들은 한 번 검증해 읽으며 수정하지 않습니다. 이후 이전 번들이 바뀌어도 저장된 선택 결과는 바뀌지 않습니다. 프로필을 보완할 때 같은 이전 번들과 필터를 유지하세요. 맥락 질문과 검토 조건도 계속 적용하며, `--reviewed`는 검토 확인만 처리합니다.

이전에 없었다는 표시가 새로 유입된 버그나 회귀를 확정하지는 않습니다. 부분 내보내기·기간·수집 범위 차이 등 비교 경고를 유지하고, 수집 이벤트와 수동 제출 보고서를 섞으면 거부합니다. 출력은 이전 번들의 `results` 폴더 밖에 있는 새 디렉터리만 허용합니다. API는 `await analyzeWithBaseline(content, baselineDirectory, { minCount: 3, top: 10, profile })`이며 이전 번들 검증도 수행합니다.

**특정 오류 묶음만 골라 TC를 생성**하려면 `--group`을 사용하세요. 먼저 분석한 `report.md`나 `analysis.json`에서 묶음 ID를 확인합니다.

```sh
error-to-test analyze --input errors.json --out ./all-errors
# 아래 예시 ID를 ./all-errors/report.md의 실제 ID로 바꾸세요.
error-to-test analyze --input errors.json --group group-0123456789abcdef --group group-fedcba9876543210 --out ./selected-tcs
error-to-test init-profile ./selected-tcs --out ./selected-profile.json
```

최대 100회 지정할 수 있으며 중복 ID는 한 번만 적용합니다. `group-` 뒤에 소문자 16진수 16자리가 붙는 정확한 ID여야 하며, 현재 입력의 원본·날짜 필터를 적용한 뒤에도 존재해야 합니다. 다른 릴리스·변경된 입력·제외된 기간의 ID 등 알 수 없는 ID는 번들 생성 전에 오류로 알립니다. ID를 얻은 분석과 같은 원본 파일·순서·수동 메타데이터·날짜 필터로 다시 분석하세요.

지정한 묶음과 `--baseline`의 교집합에 기존 순위대로 `--min-count`, `--top`을 적용합니다. ID를 입력한 순서로 우선순위가 바뀌지 않습니다. 알려진 ID라도 이 조건 때문에 TC가 생성되지 않을 수 있으며, 선택된 TC가 없으면 suite 없는 정상 번들을 만들고 `readiness`는 `empty`와 종료 코드 2를 반환합니다. 한 묶음에 여러 프로필 규칙이 적용되면 기존처럼 여러 TC를 생성할 수 있습니다.

전체 오류 묶음·원본 해시·수집 범위는 보존합니다. 요청한 ID는 정렬·중복 제거해 `analysis.groupFilter.groupIds`에 기록하고 분석 해시로 보호하며, 보고서에도 선택 범위를 남깁니다. 비교와 이전 분석 기준의 건수는 전체 묶음을 계속 사용합니다. 맥락 질문과 검토 조건도 유지합니다. `--group`을 생략하면 기존 선택 방식이며, 다른 명령에서는 거부합니다. API는 `analyzeErrors(content, { groupIds: [groupId] })`와 `analyzeWithBaseline()`의 같은 옵션입니다. 비어 있지 않은 최대 100개 항목 배열을 받으며 입력 배열을 변경하지 않습니다.

`report.md` 상단에서 TC 초안 수와 추가 정보가 필요한 TC 수를 확인할 수 있습니다. 초안도 실행 전에 검토해야 합니다. 오류 묶음·수집 건수와 함께 대표 로그의 오류·React 컴포넌트 스택, 재현 방법·사전 조건·테스트 단계·부족한 정보도 표시합니다. 같은 스택은 한 번만 표시하며, 전체 로그의 모든 스택을 나열하지는 않습니다. 재현 단계와 정상 기대 결과, 명시적인 assertion이 없으면 질문이 있는 TC를 생성합니다. 직접 입력한 보고서에는 실제 발생 시각·사용자 수를 만들어 넣지 않습니다. 수집 건수도 실제 발생률을 뜻하지 않으며, 원본 내보내기의 일부 데이터 표시를 유지합니다.

기본 suite는 검토 질문으로 실행이 차단됩니다. TC와 프로필을 확인한 뒤 다른 출력 폴더에 `--reviewed`로 다시 생성하면 검토 질문만 제거됩니다. 나머지 질문은 그대로 실행을 차단합니다. 프로필의 `setupConfirmed`는 준비 조건을 확인했다는 표시이며, 계정·데이터를 자동으로 준비하는 기능은 아닙니다.

프로필 JSON은 기존 분석 결과에서 틀을 자동으로 만들 수 있습니다.

```sh
error-to-test analyze --input errors.json --min-count 3 --out ./initial-analysis
error-to-test init-profile ./initial-analysis --out ./review-profile.json
# report.md와 확인한 앱 요구사항을 보며 review-profile.json 수정
error-to-test analyze --input errors.json --min-count 3 --profile ./review-profile.json --out ./review-analysis
```

선택된 오류 묶음마다 규칙을 하나씩 만들고 `match.groupId`로 정확히 연결합니다. 메시지·페이지가 같아도 소스 위치나 릴리스가 다른 묶음에 규칙이 퍼지지 않습니다. 같은 원본 입력과 필터·수동 메타데이터를 유지해서 다시 분석하세요. 새로 생기거나 달라진 묶음은 별도 검토가 필요합니다.

각 규칙의 `requirement`와 `expectedSource`를 채우고, `preconditions`와 명시적인 재현 동작·assertion을 `steps`에 작성하세요. 확인된 관측 페이지 경로만 `open` 단계로 미리 넣으며, 동작이나 기대 결과는 추측하지 않습니다. 준비 조건을 확인한 뒤 `setupConfirmed: true`로 바꾸고, 생성된 질문에 답한 뒤 해당 질문을 제거하세요. 처음 생성한 빈 기대 결과·출처는 검증에서 거부됩니다. 나머지 질문, 원본의 충돌, 실행 환경 확인과 기존 검토 게이트도 계속 적용됩니다.

`init-profile`은 검증에 통과한 번들만 읽고 새 파일에 저장합니다. 수정된 번들, 선택된 TC가 없는 결과, 기존 출력 파일은 거부합니다. 원래 분석 산출물을 덮어쓰지 않습니다. API의 `createProfileTemplate(analysis)`도 편집용 `error-to-test/profile-1` 객체를 만들며, 완성된 실행 프로필을 의미하지 않습니다.

이미 작성한 프로필은 `--profile`로 이어서 보완할 수 있습니다.

```sh
error-to-test analyze --input current-errors.jsonl --format jsonl --out ./current-analysis
error-to-test init-profile ./current-analysis --profile ./existing-profile.json --out ./expanded-profile.json
# 새로 추가된 빈 요구사항·출처·준비 조건·동작·assertion 작성
error-to-test analyze --input current-errors.jsonl --format jsonl --profile ./expanded-profile.json --out ./expanded-analysis
```

기존 프로필은 요구사항·기대 결과 출처 등 일반 프로필 검증을 통과해야 합니다. 이름과 규칙 순서·ID·조건·단계·기대 결과·준비 확인·질문을 검증된 값 그대로 보존합니다. 알 수 없는 필드와 파일 서식은 보존하지 않습니다. 기존 질문과 준비 미확인 상태도 남아 실행을 차단합니다.

TC 생성과 동일하게 모든 조건을 함께 검사해 기존 규칙이 적용되는 선택 묶음을 찾습니다. 넓은 조건의 규칙은 원래 조건 안에서 여러 묶음에 적용될 수 있습니다. 다른 릴리스의 정확한 `match.groupId`는 그대로 두며, 새 묶음에 단계·기대 결과를 복사하지 않습니다. 기존 규칙이 없는 선택 묶음에만 순위대로 빈 검토 항목을 붙입니다. 새 항목의 ID가 충돌하면 숫자 접미사를 붙이고 기존 ID는 유지합니다. 모두 기존 규칙으로 다뤄지면 항목을 추가하지 않습니다.

새 항목은 기대 결과·출처가 비어 있고, 준비 미확인과 검토 질문을 유지합니다. 직접 채운 뒤 원래 입력·메타데이터·필터·이전 분석 기준으로 다시 분석하세요. 기존 검토 조건도 적용합니다. 과거 규칙을 자동 삭제하지 않으므로 합산 100개 규칙·1 MiB 한도를 지켜야 합니다. 민감한 정보가 있는 기존 메타데이터·실행 단계는 파일 생성 전에 거부합니다. 기본·확장 템플릿 모두 번들의 `results` 폴더 밖에 있는 새 파일에 저장합니다.

API는 `createProfileTemplate(analysis, { profile: existingProfile })`입니다. JSON 값만으로 구성한 객체 또는 BOM 하나를 지원하는 JSON 문자열을 1 MiB까지 받으며 입력 객체를 변경하지 않습니다. 객체의 선택 필드가 `undefined`이면 해당 속성을 생략하세요. `profile`을 생략하면 기존 빈 템플릿을 만듭니다.

```sh
node bin/error-to-test.mjs verify .error-to-test/example --input examples/errors.json --profile examples/profile.json
node bin/error-to-test.mjs analyze --input examples/errors.json --profile examples/profile.json --reviewed --out .error-to-test/reviewed
cd .error-to-test/reviewed
flow-qa validate cases/error-to-test.json
flow-qa generate cases/error-to-test.json
flow-qa init
flow-qa ui
```

실행 전에는 `readiness`로 **선택된 TC의 기록된 차단 사유**를 모아 확인할 수 있습니다.

```sh
error-to-test readiness ./review-analysis
error-to-test readiness ./review-analysis --format json
```

번들을 검증한 뒤 초안·추가 정보 필요·실행 차단 건수, 검토 확인 여부와 TC별 미해결 질문을 표시합니다. 실제 내보낸 Flow QA suite의 질문도 반영하므로 검토 대기나 민감한 실행 단계 때문에 차단된 경우도 남습니다.

| 종료 코드 | 의미 |
| --- | --- |
| `0` | 선택된 TC가 하나 이상이고, 모두 검토된 초안이며 기록된 차단 사유가 없음 |
| `1` | 잘못된 옵션·잘못되거나 변경된 번들·출력 오류 |
| `2` | 차단된 TC가 있거나 선택된 TC가 없음 |

전체 보고서를 stdout에 출력한 뒤 0 또는 2를 반환합니다. JSON은 `error-to-test/readiness-1`이며 `status`(`ready`·`blocked`·`empty`), 검토 상태·건수·TC별 `blockers`·입력/분석/suite 해시를 제공합니다. API는 `await readReadiness(directory)`와 `renderReadiness(summary)`이며 API 호출은 종료 코드를 변경하지 않습니다.

저장된 번들의 질문과 검토 상태를 점검하는 기능입니다. 브라우저 실행·계정·준비 데이터·수집 범위를 확인하거나 연결 실행 결과를 읽지는 않습니다. `--top`·`--min-count`·이전 분석 기준으로 제외된 묶음은 선택 TC 건수에 포함되지 않습니다. 검토 확인만으로 미해결 맥락이 사라지지 않으며, 빈 선택도 통과시키지 않습니다. 원본 입력·프로필 바이트 확인은 `verify --input ... --profile ...`로 별도 수행하세요. 번들 경로와 선택적인 `--format text|json`만 받으며 파일을 저장하거나 기존 TC를 승인하지 않습니다.

Flow QA 설치와 실행 대상 설정은 별도로 필요합니다. 위 `flows/`·`cases/` 구조를 기존 검토 화면에서 읽을 수 있습니다. 분석 명령은 브라우저를 실행하거나 외부 모델에 요청하지 않습니다. TC 통과만으로 원래 오류를 수정 완료 처리하지 않습니다.

실행 후 `node bin/error-to-test.mjs link-run .error-to-test/reviewed --report /path/to/qa-report.json`으로 결과를 원래 오류 묶음에 연결할 수 있습니다. suite 해시와 모든 case ID가 일치해야 하며, 결과는 `results/<runId>.json`에 저장합니다. 원본 e2e 리포트 대신 Flow QA가 정리한 `report-1`을 사용하세요.

연결한 결과는 `results`로 오류 묶음별 최신 TC 결과를 모아 볼 수 있습니다.

```sh
error-to-test results .error-to-test/reviewed
error-to-test results .error-to-test/reviewed --out ./run-summary.md
error-to-test results .error-to-test/reviewed --format json --out ./run-summary.json
```

연결된 실행 수, 최신 실행의 상태·시각, TC 상태별 건수와 묶음별 결과·사유를 표시합니다. 통과·실패·flaky·차단·건너뜀·오류를 구분하고, 실행 결과가 없으면 선택된 TC를 `not-run`으로 표시합니다. TC가 선택되지 않은 원본 묶음도 남습니다.

보고된 종료 시각이 가장 늦은 실행 하나를 기준으로 합니다. 종료 시각이 같으면 시작 시각, 실행 ID 순으로 결정하며 파일 수정 시각은 사용하지 않습니다. 여러 실행의 통과 결과를 섞지 않습니다. 연결된 실행이 있으면 검토 대기와 미확인 맥락도 표시하며, 결과를 원래 오류의 수정 완료나 실행 승인으로 취급하지 않습니다.

출력 전에 번들과 연결 결과의 형식·원본/suite 해시·case/group/event 연결·상태·시각을 검사합니다. 오래된 결과라도 잘못된 JSON이 있으면 실패하며, 기존 산출물과 결과 파일은 수정하지 않습니다. 결과 폴더는 최대 1,000개 항목, 각 JSON은 2 MiB, 전체 결과는 64 MiB까지 지원합니다. 다른 확장자의 부수 파일은 무시하고 잘못된 JSON 이름·심볼릭 링크·일반 파일이 아닌 결과·한도 초과는 거부합니다. `--out`은 번들의 `results` 폴더 밖에 있는 새 파일만 허용합니다.

API에서는 `await readRunSummary(directory)`로 같은 데이터를 읽고 `renderRunSummary(summary)`로 Markdown을 만듭니다.

직접 입력은 문자열, 텍스트 파일, 표준 입력, `error-to-test/manual-1` JSON을 지원합니다. 파일 구조는 [수동 오류 예제](examples/manual.json), 정상 기대 동작과 단계 연결은 [프로필 예제](examples/profile.json)를 참고하세요. 전체 옵션은 `node bin/error-to-test.mjs --help`로 확인할 수 있습니다.

알려진 자격증명·이메일·URL 인증/쿼리 정보는 결과에서 정제합니다. 민감정보가 포함된 실행 단계나 기대 결과는 변경해 통과시키지 않고 질문으로 남깁니다. 모든 개인정보를 제거한다고 보장하지 않으므로 실제 업무 데이터를 입력하기 전에는 별도로 정제하세요. 비공개 오류는 셸 기록에 남는 인자 대신 파일·표준 입력을 사용하세요.

검증은 `npm run check`, `npm run check:package`입니다. 로컬 SDK·Flow QA와 Chromium이 준비되면 `FLOW_QA_SOURCE=/path/to/flow-qa BROWSER_ERROR_SOURCE=/path/to/browser-error-log npm run smoke:flowqa`로 수정 전 실패·수정 후 통과와 미확인 TC 차단을 확인할 수 있습니다. 자세한 입력 계약과 제한은 [영문 문서](README.md)에 있습니다.
