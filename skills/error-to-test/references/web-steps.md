# Authoring supported web steps

Use these shapes for a profile scenario's `steps` and for manual JSON reports containing steps. They describe the current `WebStep` contract; confirm the installed package version and public `dist/types.d.ts` when using an older copied skill. Objects reject unsupported fields. A Flow QA example suite can illustrate syntax, but its product expectations are not evidence for the user's app.

| `type` | Other fields | Meaning |
| --- | --- | --- |
| `open` | `path` | App-relative path beginning with `/`, not `//`. |
| `click` | `locator` | Click the identified element. |
| `fill` | `locator`, `value` | Fill text; an empty string is allowed. |
| `assertVisible` | `locator`, `visible` | Check visible/hidden; `visible` defaults to `true`. |
| `assertText` | `locator`, `expected`, `match` | `match` is `equals` (default) or `contains`. |
| `assertUrl` | `expected` | Check the expected URL. |
| `act` | `instruction` | Agent-directed action within the chosen target. |
| `assertAgent` | `instruction` | Agent observation of an explicitly stated expectation. |

A role locator is `{ "by": "role", "value": "button", "name": "Save" }`. Other locators use `by` equal to `text`, `label`, or `testId` and a string `value`; for example, `{ "by": "testId", "value": "save-status" }`. CSS/XPath locators, arbitrary JavaScript, `assertEnabled`, and `assertDisabled` are not part of this contract. Prefer the observed accessible role/name or a stable test ID; do not invent an element that was not found in the app.

For example, **if confirmed requirements and the actual app** say Save changes the `save-status` test ID to Saved, a scenario can include:

```json
[
  { "type": "open", "path": "/" },
  { "type": "click", "locator": { "by": "role", "value": "button", "name": "Save" } },
  { "type": "assertText", "locator": { "by": "testId", "value": "save-status" }, "expected": "Saved", "match": "equals" }
]
```

Each case must establish its own start state. `preconditions` are descriptions, not executed setup. Include supported reset actions when that reset is authorized and available; otherwise keep the setup question unresolved.

## Expectations the chosen runner cannot check

Fixed steps do not directly assert an element's disabled state or arbitrary attributes. Do not replace a confirmed disabled-state requirement with a text assertion and call that requirement verified. Record the missing automated check and choose an authorized verification path:

- A separate manual browser check can observe the property and retain evidence, explicitly outside the engine report.
- `assertAgent` can express the expectation. Flow QA's native runner then needs a configured agent model; it does not become a fixed, model-free assertion. In an external-agent handoff, the receiving browser agent can inspect it with its own tools.
- If the expectation or how to observe it remains unclear, retain the question/blocker instead of marking it passed.

Review acknowledgement and schema validation do not prove that every phrase of a requirement has a matching assertion. Report what the executed steps actually covered and which checks remain separate or unverified. External agent observations also remain distinct from a normalized engine `qa-report.json` used by `link-run`.
