# Inventory App — Project Plan

> **One product, one database, one backend, two clients.** The web app is the complete inventory application —
> every operational function, full traceability (batch, serial, expiry), administration, and its own Zebra
> device layer. The mobile app is the same product on the warehouse floor.
>
> **v1 is production-complete.** Traceability is in the first migration, not a later phase. Zebra connectors are
> built and ready before hardware exists. And the whole system runs in **Demo mode** — real code, real backend,
> demo database, simulated devices — so it can demonstrate itself end to end with nothing plugged in.
>
> Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · API: [API_CONTRACT.md](API_CONTRACT.md) ·
> Hardware: [DEVICE_INTEGRATION.md](DEVICE_INTEGRATION.md) · Demo: [DEMO_MODE.md](DEMO_MODE.md)
> Status: **draft for approval** · Last updated: 2026-09-17.

---

## 1. Where we are starting from

|                                     |                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web app**                         | Empty directory. Greenfield.                                                                                                                                                                                                                                                                                                                 |
| **Mobile app**                      | Working Android MVP, demoed to the client. Screens, domain rules and the Zebra device layer are real and unit-tested; **repositories are in-memory mock data that reset on restart, and all Zebra devices are simulated** (its ADR-010).                                                                                                     |
| **What the mobile app still needs** | Backend, auth, local database, sync engine, real device adapters — its own `MVP_PLAN.md` §11.                                                                                                                                                                                                                                                |
| **What we reuse from it**           | The complete domain model and its rules: the append-only ledger, the movement types, all validation, cycle-count reconciliation, GTIN and **SGTIN-96 encoding**, the ZPL builder, the EAN-13 renderer, the device abstraction, the simulator design — **and the Kotlin unit tests, which become the specification for the TypeScript port.** |
| **Zebra hardware**                  | **None available.** Connectors are built against real protocols and tested against protocol-level simulators (DEVICE_INTEGRATION §11).                                                                                                                                                                                                       |
| **Stack**                           | Next.js App Router + TypeScript + MySQL 8 + Prisma, matching the team's existing `madenkorea-production` app.                                                                                                                                                                                                                                |

The mobile MVP proved the workflows with the client. **This project makes them real and makes the web app the
full product.** The risk is not the screens — it is ledger correctness under concurrency at the traceability
grain, the sync contract with the phone, and hardware we cannot yet touch. The plan attacks those in that order.

---

## 2. Goals

1. **A complete web application.** Every inventory function in the browser: scanning, receiving, issuing,
   moving, adjusting, scrapping, RFID cycle counting, label printing and device management — plus everything a
   phone cannot reasonably do: master data, bulk import, approvals, traceability reporting, exports,
   user administration.
2. **Production-complete traceability in v1.** Batch and lot numbers, expiry dates with FEFO and blocking,
   unit-level serial numbers linked to RFID EPCs, controlled reason codes, human-readable document numbers, and
   a full audit trail. In the first migration, at the ledger's grain.
3. **Two access tiers.** Admin for configuration, master data and governance; User for daily operations. An
   optional Supervisor tier between them for approvals and overrides.
4. **One database, one backend.** Both clients read and write the same MySQL system of record through the same
   domain rules. A movement means the same thing wherever it was created.
5. **Zebra connectors ready before the hardware.** Adapters written against real protocols — ZPL, LLRP, HID —
   and verified against protocol-level simulators, with a `selfTest()` and a bring-up checklist, so that
   plugging in a device is configuration, not development.
6. **Demo mode as a product feature.** The same application against a demo database with simulated devices, so
   every workflow can be shown end to end with nothing connected — and later, with both clients side by side,
   proving the shared backend rather than asserting it.
7. **Operable.** Backed up, restorable, observable, and deployable by someone who is not the author.

**Explicit non-goals for v1**, each separately scoped in §9: procurement and purchase orders, sales and dispatch
orders with picking, stock valuation and costing, ERP integration, SSO, real-time locationing (ATR7000),
customer portal.

---

## 3. Scope

### P0 — the system is not production-ready without these

**Foundation**

- MySQL schema, both databases: ledger, projections, **batches, serial units, expiry**, master data, barcodes,
  users, devices, counts, labels, reason codes, number sequences, audit, settings
- `lib/domain`: TypeScript port of the Kotlin domain, extended for batch and serial allocation, with the Kotlin
  tests ported to Vitest
- Transactional write path at the traceability grain: validate, allocate, append, project, in one transaction
- Auth: web session, Admin / User (/ Supervisor) tiers, server-side guards on every action and route
- **Mode resolution**: LIVE and DEMO, carried in the session and the JWT

**Traceability**

- Per-item `tracking_mode`: `NONE`, `BATCH`, `SERIAL`
- Batch register: receipt with batch and expiry, balances, status, quarantine and block
- **FEFO** allocation on issue, with supervisor override recorded on the movement
- Expiry policy: block or warn, near-expiry alerts, nightly expiry sweep
- Serial unit register: creation on receipt, named-unit issue and move, status, current location
- **EPC ↔ serial unit linkage**, so RFID counts resolve to specific physical units
- Traceability reporting: batch genealogy, recall workflow, full life history of any serial unit
- Reason codes on adjustments and scrap; human-readable document numbers on every movement and count

**Operations, on the web**

- Scan-anywhere: scan → item / batch / serial → receive, issue, move, print; unknown-barcode flow
- Multiple barcodes per item, including case barcodes with pack size
- Item list and detail; movement forms for receive, issue, move, adjust, scrap
- RFID and barcode cycle counts at the tracking grain; submit and approve
- Label printing: item, batch, serial and location templates; preview; RFID encode-on-print; reprint; history
- Devices: connect, register, live event console, connector self-test
- The ledger view with full filters, drill-down and export
- Dashboard: KPIs, low stock, **expiry board**, activity, device and sync health
- Exceptions: negative stock, rejected syncs, **serial conflicts**, expiry breaches, stale devices

**Administration**

- Master data: items, barcodes, categories, locations, sites — CRUD, soft delete, CSV import with dry run
- Users, roles, site scope; reason codes; number sequences; settings; audit log; device registry; templates

**Shared backend and API**

- `/api/v1`: device token auth, sync push and pull, movements, batches, serials, counts, print, EPC
  allocation, traceability, demo control, health — versioned
- SSE stream for live stock, count progress, tag reads and device events

**Zebra device layer**

- Tier 1 keyboard wedge, Tier 2 WebHID, server-side TCP 9100 printing, ZPL rendering from templates
- LLRP / MQTT fixed-reader connector, Zebra Browser Print adapter
- Protocol-level simulators and the conformance harness; `selfTest()`; bring-up checklist

**Demo mode**

- Second database, deterministic seed covering all three tracking modes, one-click reset
- Simulated scanner, RFID reader, fixed reader and printer; simulated offline and sync
- Mode banner, guardrails, demo login

**Operations**

- Staging and production, migrations, backups with a tested restore, error reporting, runbooks

### P1 — valuable, but the system is usable without them

- Web Bluetooth battery and status; scheduled email exports; bulk relabel and bulk print
- Advanced reports: stock ageing, count accuracy trend, expiry forecast, operator productivity
- Auto-approval of counts below a variance threshold
- RFID `locate()` proximity screen on the web

### P2 — after v1

- ERP / WMS integration through `api_clients` and an outbound queue
- Procurement: suppliers, purchase orders, goods receipt against a PO
- Sales and dispatch orders, allocation, picking lists
- Stock valuation and costing
- SSO; real-time locationing (ATR7000); mobile SSE realtime
- **Mobile app Demo mode** (mobile repo, see §7)

---

## 4. Phases

Sequenced so the highest-risk work is proven early and the mobile team is unblocked as soon as possible.
Estimates assume **one full-time developer**. With two, Phases 4, 5 and 6 parallelise with Phase 3 — see §5.

| Phase                                   | Outcome                                                              | Est.     |     |
| --------------------------------------- | -------------------------------------------------------------------- | -------- | --- |
| **0 · Foundations**                     | Repo, both schemas, auth shell, mode resolution, API contract agreed | ~1.5 wks | P0  |
| **1 · Ledger & traceability core**      | Stock moves correctly and provably, at batch and serial grain        | ~3 wks   | P0  |
| **2 · Traceability surfaces**           | Batches, serials, expiry, FEFO and recall are usable                 | ~2 wks   | P0  |
| **3 · Web operations**                  | Full inventory functionality in the browser                          | ~3.5 wks | P0  |
| **4 · Shared API & mobile sync**        | The phone runs on real data                                          | ~2 wks   | P0  |
| **5 · Zebra device layer & connectors** | Connectors built, tested, ready for hardware                         | ~3 wks   | P0  |
| **6 · Demo mode**                       | The system demonstrates itself with nothing plugged in               | ~1.5 wks | P0  |
| **7 · Administration & governance**     | Admins are self-sufficient                                           | ~1.5 wks | P0  |
| **8 · Reports, exports, imports**       | The business can get its data in and out                             | ~2 wks   | P0  |
| **9 · Hardening & launch**              | Live, backed up, observable, documented                              | ~2 wks   | P0  |

**v1 total: roughly 21 weeks (~5 months) for one developer**, or **12–13 weeks with two**, plus mobile-side
integration tracked in the mobile repo (§7). The estimate includes building and testing the Zebra connectors,
but **not** the hardware bring-up itself (§6) — that is a separate day-scale activity once devices arrive.

---

### Phase 0 · Foundations — _~1.5 weeks_

- **0.1** Next.js App Router project: TypeScript strict, Tailwind, shadcn/ui, ESLint, Prettier
- **0.2** Git repository, branch protection, GitHub Actions: typecheck, lint, test, build
- **0.3** MySQL 8 local and staging; **both databases** (`inventory`, `inventory_demo`); `.env.example`
- **0.4** Prisma schema for the full model in ARCHITECTURE §4.2 — including batches, serial units, barcodes,
  reason codes and number sequences — and the first migration, applied to both databases
- **0.5** `lib/mode.ts`: resolve LIVE / DEMO from session and JWT; two Prisma clients; the guardrails in
  DEMO_MODE §7
- **0.6** `lib/services/numbering.ts`: atomic document-number allocation
- **0.7** App shell: login, authenticated layout, sidebar, site switcher, role-aware nav, **mode banner**
- **0.8** NextAuth credentials provider, bcrypt, session, `requireRole()`, Admin / User tiers
- **0.9** **Agree the `/api/v1` contract with the mobile team**, then freeze it

_Exit:_ CI green, both databases migrate, an admin logs in, mode switching works end to end with no features
behind it yet, and the mobile team has a contract.

---

### Phase 1 · Ledger & traceability core — _~3 weeks_ · **the highest-risk phase**

No UI. This is where the system is made correct.

- **1.1** Port the Kotlin domain to `lib/domain`: `movement.ts`, `count.ts`, `stock.ts`, `gtin.ts`,
  `sgtin96.ts`, `barcode.ts`
- **1.2** Port the Kotlin tests to Vitest: `RecordMovementTest`, `SubmitCycleCountTest`, `StockProjectionTest`,
  `GtinTest`, `Sgtin96Test`, `ItemSearchTest`. **These are the specification — port them before the implementation.**
- **1.3** Extend the domain for tracking modes: `allocation.ts` — batch selection, FEFO, expiry policy, serial
  validation, pack-size resolution from the scanned barcode
- **1.4** `lib/services/movements.ts`: one transaction, deterministic lock order, `FOR UPDATE` on stock rows and
  named serial units, ledger insert, `movement_serials`, atomic projection upserts, serial status and location
  updates, duplicate-id handling, document numbering
- **1.5** `lib/services/counts.ts`: session state machine, submit, approve, batch- and serial-grain
  reconciliation, COUNT posting in one transaction
- **1.6** `lib/services/traceability.ts`: batch genealogy, recall query, serial life history
- **1.7** `rebuildProjections()` for all three projections, plus a drift check against the ledger
- **1.8** **Concurrency and traceability test suite:** parallel issues of the same item and the same batch,
  opposing MOVEs, duplicate submission, **two devices issuing the same serial unit**, expired-batch issue,
  FEFO selection, projection drift after N randomised movements across all three tracking modes
- **1.9** Audit helper, event emitter, shared error envelope

_Exit:_ the ledger is correct under concurrent writes at every tracking grain, retries are idempotent, serial
conflicts are detected rather than merged, and all three projections provably match the ledger.

---

### Phase 2 · Traceability surfaces — _~2 weeks_

- **2.1** Item tracking configuration: mode, expiry requirement, shelf life, near-expiry days
- **2.2** Item barcodes: multiple per item, types, pack size, primary flag
- **2.3** Batch register: cross-item list, per-item batches, balances, status, quarantine and block actions
- **2.4** Batch receipt flow: batch number, manufacturing and expiry dates, supplier reference
- **2.5** **Expiry board:** expired, near-expiry and healthy stock; nightly expiry sweep job; exceptions
- **2.6** FEFO on the issue form: proposed batch, override with reason, Supervisor gate
- **2.7** Serial unit register: per item, status, location, EPC; bulk serial entry and generation on receipt
- **2.8** **Serial lookup:** full life history of one unit — receipt, every move, every count, issue
- **2.9** **Recall workflow:** pick a batch → every movement, current locations, units produced → quarantine all
- **2.10** Reason codes administration and their enforcement on adjust and scrap

_Exit:_ a batch can be received, tracked, found, quarantined and recalled; a serial unit can be traced from
receipt to issue.

---

### Phase 3 · Web operations — _~3.5 weeks_

The phase that makes the web app the full product rather than an admin panel.

- **3.1** Item list: server-side search, paging, category / low-stock / zone / tracking-mode filters
- **3.2** Item detail: stock by location and batch, ledger history, low-stock and expiry badges, actions
- **3.3** Item create / edit: SKU uniqueness, EAN-13 check digit validation and generation, reorder and max
- **3.4** Locations: list by zone, per-location stock at grain, create / edit / deactivate, location labels
- **3.5** Movement forms: receive, issue, move, adjust, scrap — live on-hand, batch and serial pickers,
  identical validation and errors to the phone
- **3.6** **Scan-anywhere:** global scan listener, scan → item / batch / serial → action sheet, pack-size
  handling, unknown-barcode flow
- **3.7** **Cycle counts:** session creation, live capture (scan or RFID), running found / missing / unexpected
  at the tracking grain, submit for approval
- **3.8** **Count approval:** variance review, line and unit drill-down, approve or reject
- **3.9** **Label printing:** template render, in-browser preview with real EAN-13 bars, print, reprint, history
- **3.10** **Devices screen:** connect, register, status, live event console, `selfTest()` runner
- **3.11** Ledger view: full filter set, drill-down, CSV export
- **3.12** Dashboard: KPI tiles, low stock, expiry board, recent activity, device and sync health
- **3.13** Exceptions queue: negative stock, rejected syncs, serial conflicts, expiry breaches, stale devices
- **3.14** "How it works" explainers, mirroring the mobile app's component
- **3.15** Empty, loading and error states; toasts; scan feedback; responsive down to tablet

_Exit:_ the warehouse can be run end to end from a browser, with no phone involved.

---

### Phase 4 · Shared API & mobile sync — _~2 weeks_ · **parallelisable**

- **4.1** `lib/api` route wrapper: JWT verification, mode resolution, Zod parsing, error envelope, logging,
  rate limiting
- **4.2** `POST /v1/auth/token` and `/refresh`: device registration, `(user, device)` binding, rotation, **mode
  in the token**
- **4.3** `GET /v1/sync/pull`: opaque cursor; items, barcodes, locations, **batches, serial units**, templates,
  stock levels, settings, tombstones, paging
- **4.4** `POST /v1/sync/push`: batched movements with batch and serial payloads, per-row verdict
  (ACCEPTED / DUPLICATE / REJECTED / FLAGGED), negative-stock and **serial-conflict** flagging
- **4.5** `/v1/counts`: sessions, tag streaming, submit, approve, reject
- **4.6** `/v1/print`: one print path for both clients, backed by `print_jobs`
- **4.7** `POST /v1/epc/allocate`: serial-block allocation per item and device
- **4.8** `/v1/batches`, `/v1/serials`, `/v1/trace`: traceability endpoints
- **4.9** `GET /v1/stream`: SSE for stock, counts, tag reads, device events
- **4.10** `GET /v1/health`, device heartbeat, `last_seen_at`, app-version reporting
- **4.11** Integration suite simulating a device: go offline, queue 50 movements including batch and serial
  operations, push, verify — plus a deliberate serial conflict
- **4.12** API documentation and a Postman / `.http` collection handed to the mobile team

_Exit:_ a scripted fake device completes a full offline-to-online cycle against staging with correct results,
including traceability, and the mobile team can start replacing `:core:data`.

---

### Phase 5 · Zebra device layer & connectors — _~3 weeks_ · see DEVICE_INTEGRATION.md §11

**No hardware exists.** Everything here is built against real protocols and verified with protocol-level
simulators, so that hardware day is configuration rather than development.

- **5.1** Device abstraction in `lib/devices/types.ts`, ported from the Kotlin interfaces
- **5.2** **Tier 1 keyboard-wedge scanner**: `<ScanProvider>`, timing heuristic, routing, focus suppression,
  armed indicator. _The universal path — everything else is enhancement_
- **5.3** **Tier 2 WebHID scanner**: pairing, per-model report parsing, symbology, graceful fallback
- **5.4** **Server-side printing**: `net.Socket` to TCP 9100, `print_jobs` queue, retry, timeout, status read-back
- **5.5** ZPL rendering from `label_templates` (`lib/labels/zpl.ts`, ported from the Kotlin `Zpl` builder);
  item, batch, serial and location templates
- **5.6** Browser label preview with real EAN-13 bars, ported from the mobile `Ean13.kt`
- **5.7** RFID encode-on-print (`^RFW`) wired to EPC serial-block allocation and `serial_units.epc`
- **5.8** **Fixed RFID connector**: LLRP client and ZIoT/MQTT subscriber, EPC de-duplication, SGTIN decode to
  serial unit, `count_tags`, SSE to the browser
- **5.9** **Zebra Browser Print** adapter for locally attached printers
- **5.10** Web Bluetooth battery and status where the model exposes BLE _(P1)_
- **5.11** **Protocol-level test doubles and conformance suite** (DEVICE_INTEGRATION §11.1): TCP 9100 printer
  double, ZPL render check in CI, LLRP server double, MQTT broker in CI, synthetic HID reports, synthetic
  keystroke timings
- **5.12** **`selfTest()`** for every adapter, surfaced on the Devices screen
- **5.13** Simulators for all device types, shared with Demo mode, labelled "Simulation"
- **5.14** Hardware bring-up checklist and the scanner/printer setup sheets (DEVICE_INTEGRATION §12)

_Exit:_ every connector passes its protocol conformance suite in CI, `selfTest()` reports meaningfully against
the doubles, and the bring-up checklist is written. **Real-hardware validation is explicitly deferred to §6.**

---

### Phase 6 · Demo mode — _~1.5 weeks_ · see DEMO_MODE.md

- **6.1** Demo database provisioning and migration parity with live
- **6.2** **Demo seed**: port the mobile `SeedData` and extend it — batch-tracked items with staggered expiry
  including one near-expiry and one expired and one quarantined, serial-tracked items with unit registers and
  valid SGTIN-96 EPCs, planted count variances, demo users, demo devices, all four label templates
- **6.3** One-click reset (`POST /v1/demo/reset`), Admin-only, audited
- **6.4** Device factory binding: simulators in DEMO, real adapters in LIVE, mutually unreachable
- **6.5** Simulated offline and sync: the network toggle, pending badge, per-row verdicts including a planted
  negative-stock flag
- **6.6** Mode banner, accent, page-title badge, demo login screen with visible credentials
- **6.7** Outbound-effect guardrails: no printing, email, webhooks or integrations in DEMO
- **6.8** Demo runbook: the beat-by-beat script in DEMO_MODE §6, rehearsed

_Exit:_ the full product — including batch receipt, FEFO, expiry blocking, serial tracking, RFID counting with
unit-level variance, label printing with RFID encoding, offline sync and traceability — can be demonstrated end
to end with nothing plugged in, on the production code path.

---

### Phase 7 · Administration & governance — _~1.5 weeks_

- **7.1** User management: invite, roles, site scope, deactivate, password reset
- **7.2** Device registry administration: register network devices, assign, revoke, last seen, firmware
- **7.3** Label template editor: ZPL editing, live preview, per-kind and per-printer defaults
- **7.4** Categories, units, sites, reason codes, number sequences administration
- **7.5** Settings: expiry policy, FEFO policy, variance thresholds, adjustment limits, reorder and print defaults
- **7.6** Audit log viewer with filters
- **7.7** Role enforcement audit: every Server Action and route handler checked server-side
- **7.8** API client management for future integrations

_Exit:_ an admin can configure and run the system without a developer.

---

### Phase 8 · Reports, exports, imports — _~2 weeks_

- **8.1** CSV / XLSX import: items, barcodes, locations, opening balances, **batches and serial units**, with a
  dry-run preview and a per-row error report
- **8.2** Operational reports: stock on hand by grain, movement summary, count accuracy, stock ageing, reorder
- **8.3** **Traceability reports:** batch genealogy, recall pack, serial history, expiry forecast, expired stock
- **8.4** XLSX export on every list and report, streaming for large result sets
- **8.5** Bulk operations: bulk adjust, bulk relabel, bulk print, bulk quarantine
- **8.6** Scheduled email exports _(P1)_
- **8.7** Nightly projection-drift job, expiry sweep, and a manual rebuild action

_Exit:_ the business can get its data in and out, and can answer a recall question without a developer.

---

### Phase 9 · Hardening & launch — _~2 weeks_

- **9.1** Performance pass: query plans on the ledger, item list and traceability queries; index verification;
  seed 500k movements and 100k serial units
- **9.2** Security pass: role enforcement, **mode isolation**, rate limits, input validation, dependency audit,
  secret review, HTTPS
- **9.3** Backups: automated daily dump of live **plus a documented, executed restore drill**
- **9.4** Observability: Sentry, structured logs, health checks, alerts on sync, print and drift failures
- **9.5** Playwright coverage: login, scan, batch receipt, FEFO issue, serial issue, count approval, print,
  recall, export — in both modes
- **9.6** Deployment runbook, environment setup, network prerequisites, rollback procedure
- **9.7** User guides: User access, Admin access, scanner and printer setup sheets, demo runbook
- **9.8** Production deploy, real master data loaded, tracking modes set, opening balances and batches entered,
  go-live checklist

_Exit:_ live, with a tested restore and a runbook someone else can follow.

---

## 5. Parallelisation with two developers

|            | Developer A                          | Developer B                                         |
| ---------- | ------------------------------------ | --------------------------------------------------- |
| Weeks 1–2  | Phase 0                              | Phase 0 (schema, mode)                              |
| Weeks 3–5  | Phase 1 — ledger & traceability core | Phase 5 — device connectors and conformance harness |
| Weeks 6–8  | Phase 2 — traceability surfaces      | Phase 4 — shared API & sync · Phase 6 — demo mode   |
| Weeks 9–12 | Phase 3 — web operations             | Phase 7 — admin · Phase 8 — reports                 |
| Week 13    | Phase 9 — hardening & launch         | Phase 9                                             |

Phase 1 is on the critical path for everything that writes stock; Phase 5 has almost no dependency on it, which
is what makes this split work.

---

## 6. Hardware bring-up — a separate, later activity

Hardware validation is deliberately **not** inside the estimate, because it cannot start until devices exist.
The plan is built so that this is a day-scale activity:

1. Connectors are already written, tested against protocol doubles, and CI-green (Phase 5).
2. `selfTest()` gives a per-device diagnostic that reports what actually happened at each step.
3. The bring-up checklist (DEVICE_INTEGRATION §12) is written before the hardware arrives.
4. The tiered design means **no single device is load-bearing** — a disappointing scanner costs capability, not
   a workflow.

**What we need from you:** the model list (Q6) and, ideally, one of each device type on loan for a week. This is
the longest-lead item in the whole project.

---

## 7. Parallel work in the mobile repo

Not this project's scope, but this project unblocks it. Tracked in the mobile repo against its `MVP_PLAN.md` §11.

| Mobile work                                                                                      | Depends on                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| SQLDelight local database as the device source of truth                                          | — (can start now)                                       |
| Ktor client and real repositories replacing the in-memory ones in `:core:data`                   | Phase 0.9 contract, then Phase 4                        |
| Outbox sync engine behind the existing `SyncEngine` interface                                    | Phase 4.4                                               |
| Login and secure token storage (Keystore / Keychain)                                             | Phase 4.2                                               |
| **Batch, serial and expiry in the mobile UI** — pickers, FEFO display, unit-level count variance | Phase 1, Phase 4.3                                      |
| Count submit changed to "submitted for approval" (WADR-008)                                      | Phase 4.5                                               |
| ZPL templates pulled from the server instead of hard-coded                                       | Phase 4.3                                               |
| **Demo mode toggle at login**, pointing at the demo database through the same API                | Phase 6                                                 |
| Real Zebra SDK adapters                                                                          | Client hardware                                         |
| iOS delivery                                                                                     | Independent; needs a Mac and an Apple Developer account |

**Integration checkpoint:** when Phase 4 lands, run a joint session against staging with a real phone — offline,
queueing batch and serial movements, syncing back. Everything before that is a guess about the contract.

**The demonstration this unlocks:** once the mobile app has Demo mode (post-Phase 6), web and phone side by
side, both in Demo mode, a movement recorded on the phone appearing live on the web screen. That is the proof
that the database and backend are shared.

---

## 8. Risks

| #   | Risk                                                                                                       | Impact                                        | Mitigation                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Ledger and projections drift under concurrent writes                                                       | Wrong stock, silently                         | Single write path, `FOR UPDATE` in deterministic order, the Phase 1.8 suite, nightly drift job                                                                      |
| R2  | Web and mobile enforce different rules                                                                     | Accepted on one client, rejected on the other | One `lib/domain` ported from Kotlin, with the Kotlin tests as spec (1.1–1.2)                                                                                        |
| R3  | Traceability grain increases every query's cost and every screen's complexity                              | Slow lists, confusing forms                   | `tracking_mode NONE` keeps untracked items exactly as simple as today; indexes designed for the grain (ARCHITECTURE §4.2); 500k-row performance pass in 9.1         |
| R4  | Serial conflicts between offline devices                                                                   | Physically impossible state in the data       | Detected, flagged, quarantined — never auto-merged (WADR-020); tested in 1.8                                                                                        |
| R5  | The API contract changes after the mobile client is written                                                | An app-store release cycle to fix             | Freeze in 0.9; version `/api/v1`; additive changes only                                                                                                             |
| R6  | **Zebra hardware arrives and the connectors do not work as expected**                                      | Bring-up becomes development                  | Protocol-level conformance testing rather than mocks (5.11); `selfTest()` diagnostics; tiered fallbacks so nothing is load-bearing; ZPL verified by rendering in CI |
| R7  | **Hardware never arrives, or arrives very late**                                                           | Cannot validate; go-live slips                | Demo mode means the product is demonstrable and sellable without it; connectors are complete and waiting. **Request loan units now**                                |
| R8  | Demo data reaches live reporting, or a demo session writes live stock                                      | Loss of trust in every number                 | Separate databases, mode in the signed session and token, device factory isolation, a security check in 9.2                                                         |
| R9  | Device clock drift corrupts the sync cursor                                                                | Silent data loss on pull                      | Server-issued opaque cursor on server time; `occurred_at` and `recorded_at` stored separately                                                                       |
| R10 | Duplicate RFID EPCs from multi-device encoding                                                             | Unrecoverable once tags are printed           | Server-side serial-block allocation (4.7, 5.7); EPC unique in `serial_units`                                                                                        |
| R11 | Backups exist but restore has never been tried                                                             | Total loss                                    | A restore drill is a checklist item (9.3), not a good intention                                                                                                     |
| R12 | The client's real data does not fit the model — units, barcodes, batch formats, which items are serialised | Rework late                                   | Load a real master-data extract during Phase 2, not at go-live. Settle Q1 early                                                                                     |
| R13 | Warehouse browsers are Safari or Firefox                                                                   | Tier 2 unavailable                            | Tier 1 and server-side printing cover every workflow without Chromium                                                                                               |
| R14 | The server cannot reach printers or fixed readers on the warehouse LAN                                     | Printing and fixed RFID fail in production    | Confirm topology in Phase 0 (Q7); Browser Print is the fallback for local printers                                                                                  |
| R15 | Scope creep into full ERP                                                                                  | Timeline doubles                              | §2 non-goals explicit; each separately scoped in §9                                                                                                                 |

---

## 9. What changes if the remaining questions change

| If...                                     | Impact                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Two access tiers only, no Supervisor (Q4) | Slightly simpler. **−2 days**                                                      |
| Fixed RFID readers are out of scope (Q6)  | Phase 5.8 drops. **−4 days**                                                       |
| Procurement is in scope                   | Suppliers, POs, GRN, receipt matching against PO lines. **+3 weeks**               |
| Sales / dispatch is in scope              | Orders, allocation, picking lists, dispatch confirmation. **+3 weeks**             |
| Valuation is required                     | Cost on receipt, a valuation method, valuation reports, period close. **+2 weeks** |
| An ERP is involved                        | An outbound integration layer and adapters. **+2–3 weeks**                         |
| SSO is required                           | An identity provider on both web and mobile. **+1 week**                           |

---

## 10. Questions for sign-off

Working assumptions are in [ARCHITECTURE.md](ARCHITECTURE.md) §12; development proceeds on those unless told
otherwise. **Q1 and Q6 are worth answering early** — one shapes the data load, the other has hardware lead time.

1. **Q1 — Which items are batch-tracked, which are serial-tracked, which are neither?** A representative split
   is assumed; the real answer shapes the master-data load and the demo seed.
2. **Q2** — Expired stock: block issuing, or warn and allow with a supervisor override? _(Assumed: block.)_
3. **Q3** — Serial numbers: supplied by the manufacturer and scanned, or generated by us? _(Assumed: both.)_
4. **Q4** — Two access tiers (Admin / User), or three with a Supervisor tier?
5. **Q5** — Document-number formats, and must they be gapless for audit? _(Assumed: `PREFIX-YYYY-NNNNNN`, gapless.)_
6. **Q6 — Which Zebra models, and when can we get loan units?** Printers networked or USB/Bluetooth? Fixed RFID
   readers, or handheld sleds only?
7. **Q7** — Where does the server run, and can it reach the warehouse LAN?
8. **Q8** — One warehouse or several sites? _(Assumed: several.)_
9. **Q9** — Procurement, sales orders or valuation needed later? Any existing ERP/WMS?
10. **Q10** — SSO, or local accounts?

---

## 11. Definition of done

Per task: it typechecks and lints, CI is green, domain logic has Vitest coverage, device connectors pass their
conformance suite, roles are enforced server-side, the screen has loading / empty / error states, mutations
write to the audit log where relevant, **it works in both LIVE and DEMO mode**, and documentation is updated if
a decision changed.

Per phase: the exit criterion in §4 is demonstrated, not asserted.
