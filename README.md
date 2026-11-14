# Business-day deadlines with PingRoom

Turn work requests into due dates after a named owner chooses the applicable work calendar. PingRoom collects the choices; code counts eligible civil dates strictly after each start date and exports the counting trail.

Use this when a work intake process has several explicit calendars and a person must select one for each request. The starter calculates dates locally. It sends no reminders, changes no calendars and performs no deployment.

## Try it offline

Choose **Use this template** and clone your copy. Install Node.js 22 or newer, then run:

```sh
npm ci
npm test
npm run demo
cp examples/input.json input.json
cp config.example.json config.json
npm run preview
```

The paper-order example offers a standard workweek with one declared closure and a short trial calendar. Three demos show successful deadlines, exhausted calendar coverage and Unknown. They use the real pinned SDK with a local mock transport, need no credentials, and remove their temporary files. Live phone delivery is not tested.

## Define the requests and calendars

Edit `input.json` before starting. `preview` prints the complete validated input without contacting PingRoom. The owner must review the full calendar definitions, including every exception, before choosing; the phone question shows references and summaries, not the complete exception lists.

The input contains:

- `batchId` and `title`: a stable batch identifier and a short description.
- `calendars`: 1–3 supplied calendars, each with a unique `id`, a `label`, a `reference`, coverage dates `from` and `through`, `weekdays`, and `exceptions`.
- `requests`: 1–8 work requests, each with a unique `id`, a descriptive `context`, a `start` date, and `workingDays` from 1 to 30.

Weekdays use ISO numbers: Monday is `1`, Sunday is `7`. Supply a nonempty set without duplicates. Coverage includes both endpoints and may span at most 366 dates. Every request's start must fall inside every offered calendar, so any displayed choice is valid for that start.

Each exception has exactly `date` and Boolean `open`. It replaces the weekday rule for that date: `true` can open a weekend and `false` can close a weekday. Exception dates must be unique and covered; duplicate declarations are rejected even if they agree. Each calendar allows at most 366 exceptions. The program does not infer holidays, time zones or statutory deadline rules.

Dates must be exact Gregorian `YYYY-MM-DD` within 2000–2099. Invalid dates, timestamps and shortened forms are rejected. Counting always starts on the following date, even if the start itself is open. Closed start dates are allowed. A due date may equal the final covered date, but the program never guesses beyond the supplied horizon.

Calendar and request IDs are lowercase slugs of at most 12 characters; `unknown` and reserved object names are unavailable. `batchId` allows 40 characters. Title, calendar label, calendar reference and request context allow 40, 24, 24 and 60 UTF-16 units respectively. Metadata must be nonempty, trimmed and free of control characters. A combined prompt exceeding 500 units fails validation, so not every maximum can be used together.

The program sorts calendars and requests by ID, weekdays by number, and exceptions by date. Reordering preserves input identity; changes to meanings, dates or rules do not. Input is bounded to 256 KiB and exports to 1 MiB.

## Connect the owner

Install [PingRoom](https://pingroom.io/i), then run:

```sh
npm run connect
npm run inspect
```

Approve the printed connection link and grant the intended standard private room. Verify the owner in the app, then place their exact member UUID and descriptive label in `config.json`. A display name alone does not establish identity.

For an existing robot connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Partial or blank pairs fail; a missing value is never borrowed from another credential source. The connection needs room-list access and permission to create and read Questions in the selected room.

```sh
npm start
```

Each invocation creates at most one direct Question or reads the pending one. After the owner answers, run it again to record the response, then again for the next request. Requests are asked in ASCII ID order. Each Question lasts 15 minutes and shows the request's context, start date, day count and calendar references, coverage, weekdays, exception counts and hash prefixes. Buttons include the calendar ID and label, plus Unknown. Use metadata suitable for the selected room.

The application verifies the exact request, room, owner, asking registration and timestamps. It neither polls nor resends automatically. Unknown, expiry, cancellation, invalid answers or missing evidence withhold the entire batch analysis, although later choices can still be collected.

## Inspect and export

These commands run locally:

```sh
npm run status
npm run report
npm run export
npm run export-deadlines
```

`status` prints progress. `report` also writes `.deadlines/report.json`, including partial evidence. `export` writes `.deadlines/analysis.json` once every request has a known valid calendar choice. `export-deadlines` additionally requires every request to reach its due date and writes `.deadlines/deadlines.json`.

For each request, `analysis.results` includes the selected calendar hash, status, due date or null, counted and remaining workdays, coverage endpoint, and each visited date's weekday, open/closed decision, reason and running count. Scanning stops at the due date or inclusive coverage endpoint.

Insufficient coverage is a complete `coverage_exhausted` diagnostic. Other successful dates remain visible in that analysis, but `analysis.deadlines` stays null unless every request succeeds. Unknown or missing evidence makes the whole `analysis` null.

A complete exhausted analysis exits `0`; inspect `analysis.allScheduled` or require `export-deadlines` in an integration. Run/recover exits `1` for errors, `2` for failed or incomplete answers, `3` for pending/ready/interrupted work, and `4` for uncertain creation. Offline reporting exits `0` when it successfully prints a partial report.

## Resume and adapt

Preserve `.deadlines/state.json` after a lost response. Run `npm run find-id`, inspect candidates, then `npm run recover -- QUESTION_UUID` for the exact original Question. No match in the bounded search does not prove creation failed. Never delete state to retry a send.

Pairing retains its pending bearer/session or uncertain creation intent. Resume a known pairing with `npm run connect`; inspect Connected Agents and resolve or revoke the old registration before restarting uncertain or expired setup.

Keep input, configuration, room and credentials unchanged throughout a session. Resolve the original session before archiving `.deadlines/` for revised inputs. Remove a stale lock only after confirming no process is active. Root inputs, credentials and runtime state are ignored by Git. State/output writes are atomic and private: files use mode `0600`, directories `0700`. Hashes detect mismatches; they are not independently signed history.

Adapt your intake system to generate this bounded input, review the full calendar definitions, and consume the exported dates. Time-of-day cutoffs, timezone conversion, notifications, external calendar writes and rules outside supplied coverage require separate integration.

The starter pins `@pingroom/sdk` 0.8.0 with a lockfile. `.npmrc` requests exact saves and a 14-day minimum release age where npm supports it. Commit-pinned GitHub Actions check Node 22 and 24. Tests compare civil arithmetic with an independent UTC oracle and cover failure, recovery, pairing, CLI behavior and maximum output. MIT licensed.
