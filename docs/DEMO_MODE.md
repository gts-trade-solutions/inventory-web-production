# Demo Mode

> The application must be able to demonstrate itself end to end with **no Zebra hardware and no real data** —
> and the demo must be evidence about the production system, not a mock-up of it.
>
> Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) §8 · Hardware: [DEVICE_INTEGRATION.md](DEVICE_INTEGRATION.md)
> · Plan: [PROJECT_PLAN.md](PROJECT_PLAN.md) Phase 6

---

## 1. The idea in one paragraph

Demo mode runs **the same application, the same services, the same API and the same ledger transactions** — but
against a separate MySQL database seeded with deterministic demo data, with the Zebra device layer bound to
simulators instead of real adapters. Nothing in `lib/domain` or `lib/services` knows which mode it is in. That
is the whole design, and it is what makes a demo meaningful: when a cycle count finds a variance in Demo mode,
it found it by running the real reconciliation code against a real MySQL table.

---

## 2. Live versus Demo

|                               | **LIVE**                               | **DEMO**                                                                |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Database                      | `inventory`                            | `inventory_demo` — **identical schema**, deterministic seed             |
| Devices                       | Real adapters only                     | Simulators only                                                         |
| Application code              | The full application                   | **The same full application**                                           |
| API                           | `/api/v1`                              | `/api/v1`, mode carried in the token                                    |
| Printing                      | Real ZPL to a real printer             | ZPL generated and previewed; nothing transmitted                        |
| Email, integrations, webhooks | Live                                   | Blocked at the boundary                                                 |
| Appearance                    | Normal                                 | Persistent banner, distinct accent colour, "DEMO" badge on every screen |
| Reset                         | Impossible                             | One click; restores the seed exactly                                    |
| Who can enter it              | Any user, if enabled for their account |                                                                         |
| Who can reset it              | Admin                                  |                                                                         |

**The two databases never meet.** Mode is resolved from the session (web) or the JWT (mobile) by `lib/mode.ts`,
which hands the matching Prisma client to the services. A service has no way to reach the other database, so
demo data cannot leak into live reporting and a demo session cannot write live stock (WADR-024).

---

## 3. Why not mock repositories

The mobile MVP demonstrates on in-memory mocks. That was the right call for its deadline, but it means the demo
proves the UI and nothing beneath it. Three things change when the demo runs on the real stack:

1. **It proves the backend.** Real transactions, real row locking, real idempotency, real validation errors. If
   the ledger has a concurrency bug, the demo can hit it — which is a feature.
2. **It proves the shared database.** Open the web app and the phone side by side, both in Demo mode, record a
   movement on the phone and watch it appear on the web screen. That demonstrates the shared backend rather
   than asserting it — and it is the single most convincing thing this project can show.
3. **It is a real test environment.** Demo mode doubles as the training environment for new operators and the
   integration sandbox for the mobile team.

---

## 4. The demo dataset

Ported from the mobile app's `SeedData` (50 SKUs across 6 locations, opening balances, a few days of history,
valid EAN-13 barcodes, real SGTIN-96 EPCs per unit) and extended for the traceability model. Deterministic —
every demo starts from exactly the same state.

| Aspect                | Seeded as                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Items                 | 50 SKUs across Packaging, Safety, Tools and Consumables                                                                                          |
| **Tracking modes**    | ~35 `NONE` (consumables), ~10 `BATCH` (adhesives, chemicals), ~5 `SERIAL` (power tools, instruments)                                             |
| Locations             | RCV (inbound), A-01, A-02, B-01, B-02 (storage), DSP (outbound), across 2 sites                                                                  |
| **Batches**           | 2–4 per batch-tracked item with staggered expiry: several healthy, **one near-expiry**, **one already expired**, **one quarantined**             |
| **Serial units**      | Full unit registers for serial-tracked items, each with a valid SGTIN-96 EPC                                                                     |
| Opening balances      | Realistic quantities, several items deliberately below reorder point                                                                             |
| History               | A few days of movements with document numbers, across all types and both users                                                                   |
| **Planted variances** | Each storage location starts with two missing units and one stray unit, so a cycle count finds something real (mirrors the mobile app's ADR-011) |
| Users                 | One Admin, one Supervisor, one User, with obvious demo credentials                                                                               |
| Devices               | One simulated ring scanner, one simulated RFID reader, one simulated printer, one simulated fixed reader                                         |
| Label templates       | Item, batch, serial and location templates, one RFID-enabled                                                                                     |

**Reset** (`POST /api/v1/demo/reset`, Admin only) drops and reseeds `inventory_demo` in a transaction, typically
in a couple of seconds. It is on the admin screen and is expected to be used between demos.

---

## 5. Simulated devices

The mobile MVP's simulators are the reference: they behave like hardware rather than returning canned results
(its ADR-011). The web simulators match them, and the same simulator drives both clients in Demo mode.

| Device            | Simulated behaviour                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ring scanner**  | Emits barcodes from the demo dataset on a soft trigger; supports piece and case barcodes; realistic inter-scan timing; a configurable unknown-barcode scan |
| **RFID reader**   | Trigger press and release, a tag stream with de-duplication and realistic RSSI decay, transmit-power range, battery drain, `locate()` proximity            |
| **Fixed reader**  | Streams tag reads as if a pallet passed a dock portal, including stray reads to exercise filtering                                                         |
| **Label printer** | Accepts real ZPL, returns status (ready, paper out, head open), reports a job and labels remaining, renders a preview of what would print                  |

Simulators are labelled **"Simulation"** in the UI, exactly as on mobile. That transparency is deliberate: it is
presented as an engineering choice — build and test without hardware, swap in real implementations behind the
same interface — not glossed over.

---

## 6. Demonstrating without hardware

What a demo can show today, with no Zebra device in the room:

| Beat                         | What it shows                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scan to receive**          | Soft-trigger the simulated scanner → item found → receive 24 into RCV → stock and ledger update → document number `RCV-2026-000xxx` issued                                |
| **Batch receipt**            | Receive a batch-tracked item → batch number and expiry captured → batch appears in the register with its expiry status                                                    |
| **Serial receipt**           | Receive a serial-tracked item → five unit records created, each with its own EPC                                                                                          |
| **Print a label**            | Real ZPL generated from the database template, previewed with real EAN-13 bars, RFID encoding toggled on → EPC allocated and written to the unit                          |
| **FEFO issue**               | Issue a batch item → the system proposes the earliest-expiring batch → override requires Supervisor → the override is recorded on the movement                            |
| **Expiry block**             | Try to issue the expired batch → blocked, with the policy explained                                                                                                       |
| **RFID cycle count**         | Start a count at A-01 → simulated tag stream → unique tags climb → stop → _these two specific units are missing, this one is unexpected_ → submit for approval            |
| **Approval**                 | Log in as Supervisor → review the variance line by line → approve → COUNT movements post → recount matches                                                                |
| **Traceability**             | Pick a batch → every movement, every current location, every unit it produced. Pick a serial → its whole life, receipt to issue                                           |
| **Offline and sync**         | Switch the simulated network off → record movements → "3 pending" → switch back on → per-row verdicts, including one deliberate negative-stock flag landing in Exceptions |
| **Two clients, one backend** | _(once the mobile app joins)_ Record on the phone, watch it appear on the web screen live over SSE                                                                        |
| **Devices**                  | Connect and disconnect simulated devices, watch the live event console, run the connector self-test                                                                       |

Every one of those runs the production code path. The only substitutions are the database and the device
transport.

---

## 7. Guardrails

These are requirements, not conventions. Getting them wrong once destroys trust in the whole system.

1. **Mode cannot be spoofed.** It is in the signed session and the signed JWT — never a header, query parameter
   or client setting.
2. **Demo mode is visually unmistakable.** A persistent banner, a distinct accent colour, and "DEMO" in the page
   title, so a screenshot is never ambiguous.
3. **Real devices are unreachable in Demo mode, and simulators are unreachable in Live mode.** Enforced in the
   device factory, not by convention. Nobody prints demo labels on the warehouse printer, and nobody records a
   simulated receipt against live stock.
4. **Outbound effects are blocked** in Demo mode at the service boundary: no email, no webhooks, no
   integrations, no printing.
5. **Live mode never shows demo data**, and demo data is excluded from every report, export and backup of the
   live database.
6. **Reset is Admin-only**, is audited, and asks for confirmation.
7. **Demo credentials are visible on the demo login screen** and cannot log into Live mode.

---

## 8. The mobile app joins later

Once the mobile app's backend integration lands (PROJECT_PLAN §6), it adopts the same switch: a mode toggle at
login that points the same API client at the demo database. **No mock data on the phone** — the phone in Demo
mode is the real app, talking to the real backend, against the demo database.

That is what makes the side-by-side demonstration work, and it removes the mobile app's current limitation that
its data resets on restart and exists only on that device.

---

## 9. What Demo mode is not

- **Not a sales-only feature.** It is the training environment and the mobile team's integration sandbox.
- **Not a substitute for hardware testing.** It proves the workflows and the backend; it cannot prove that a
  specific RS6000 in HID mode sends the terminator we expect. See DEVICE_INTEGRATION §10 and §11.
- **Not a place to put real data.** Anything typed into Demo mode is expected to be destroyed on the next reset.
