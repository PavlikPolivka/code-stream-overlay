# CSV export for orders

Ship a CSV export on the orders page before the stream ends.

## Must

- [x] Scope the feature
- [ ] **Export** endpoint `GET /orders.csv`
  - [x] Header row
  - [ ] Quote fields with commas
    - [ ] Escape embedded quotes
- [X] Wire the [download button](https://example.com/ui)
* [ ] Tests for edge cases
+ [ ] README section

Notes, not tasks:

- remember to check the Excel BOM thing

```md
- [ ] this is inside a code fence and must be ignored
```

## Stretch goals

- [ ] Streaming for large exports
	- [ ] Backpressure
- [x] Progress indicator

## Later

- [ ] Localized headers
