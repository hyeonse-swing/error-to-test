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

결과는 `analysis.json`, `report.md`, `flows/error-to-test.md`, `cases/error-to-test.json`, `provenance.json`입니다. 빈 조회 결과에는 suite를 만들지 않습니다. 출력 폴더는 매번 새 경로를 지정해야 합니다.

`report.md`에서 오류 묶음·수집 건수와 함께 재현 방법·사전 조건·테스트 단계·부족한 정보를 확인하세요. 재현 단계와 정상 기대 결과, 명시적인 assertion이 없으면 질문이 있는 TC를 생성합니다. 직접 입력한 보고서에는 실제 발생 시각·사용자 수를 만들어 넣지 않습니다. 수집 건수도 실제 발생률을 뜻하지 않으며, 원본 내보내기의 일부 데이터 표시를 유지합니다.

기본 suite는 검토 질문으로 실행이 차단됩니다. TC와 프로필을 확인한 뒤 다른 출력 폴더에 `--reviewed`로 다시 생성하면 검토 질문만 제거됩니다. 나머지 질문은 그대로 실행을 차단합니다. 프로필의 `setupConfirmed`는 준비 조건을 확인했다는 표시이며, 계정·데이터를 자동으로 준비하는 기능은 아닙니다.

```sh
node bin/error-to-test.mjs verify .error-to-test/example --input examples/errors.json --profile examples/profile.json
node bin/error-to-test.mjs analyze --input examples/errors.json --profile examples/profile.json --reviewed --out .error-to-test/reviewed
cd .error-to-test/reviewed
flow-qa validate cases/error-to-test.json
flow-qa generate cases/error-to-test.json
flow-qa init
flow-qa ui
```

Flow QA 설치와 실행 대상 설정은 별도로 필요합니다. 위 `flows/`·`cases/` 구조를 기존 검토 화면에서 읽을 수 있습니다. 분석 명령은 브라우저를 실행하거나 외부 모델에 요청하지 않습니다. TC 통과만으로 원래 오류를 수정 완료 처리하지 않습니다.

실행 후 `node bin/error-to-test.mjs link-run .error-to-test/reviewed --report /path/to/qa-report.json`으로 결과를 원래 오류 묶음에 연결할 수 있습니다. suite 해시와 모든 case ID가 일치해야 하며, 결과는 `results/<runId>.json`에 저장합니다. 원본 e2e 리포트 대신 Flow QA가 정리한 `report-1`을 사용하세요.

직접 입력은 문자열, 텍스트 파일, 표준 입력, `error-to-test/manual-1` JSON을 지원합니다. 파일 구조는 [수동 오류 예제](examples/manual.json), 정상 기대 동작과 단계 연결은 [프로필 예제](examples/profile.json)를 참고하세요. 전체 옵션은 `node bin/error-to-test.mjs --help`로 확인할 수 있습니다.

알려진 자격증명·이메일·URL 인증/쿼리 정보는 결과에서 정제합니다. 민감정보가 포함된 실행 단계나 기대 결과는 변경해 통과시키지 않고 질문으로 남깁니다. 모든 개인정보를 제거한다고 보장하지 않으므로 실제 업무 데이터를 입력하기 전에는 별도로 정제하세요. 비공개 오류는 셸 기록에 남는 인자 대신 파일·표준 입력을 사용하세요.

검증은 `npm run check`, `npm run check:package`입니다. 로컬 SDK·Flow QA와 Chromium이 준비되면 `FLOW_QA_SOURCE=/path/to/flow-qa BROWSER_ERROR_SOURCE=/path/to/browser-error-log npm run smoke:flowqa`로 수정 전 실패·수정 후 통과와 미확인 TC 차단을 확인할 수 있습니다. 자세한 입력 계약과 제한은 [영문 문서](README.md)에 있습니다.
