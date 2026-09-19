# Inventory App — Web

The **web application** for the inventory system: the complete product, built on **Next.js (App Router) +
MySQL**. Every inventory function in the browser — scanning, receiving, issuing, moving, adjusting, scrapping,
RFID cycle counting, label printing and device management — with **full traceability** (batch, lot, expiry,
unit-level serial numbers) and administration: master data, users and roles, settings, reporting, exports, audit.

It ships with the **shared backend** that the mobile app (`inventory-mobile-app`, Kotlin Multiplatform) also
runs on. One product, one database, one set of rules, two clients.

```
             Web app  ─┐
                       ├─►  shared backend  ─►  MySQL  (append-only ledger · batches · serial units)
          Mobile app  ─┘         │
                                 └─►  Zebra devices: scanners · RFID readers · printers
```

> **Status: built, and running against MySQL.** Phases 1–9 are in: the ledger, traceability, the device layer
> and its simulators, demo mode, the admin surface, import and export, the recall pack, rate limiting, backups
> and a restore that has actually been performed. Remaining work is listed in
> [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md). Deploying it: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Documentation

| Document                                                 | What it covers                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)             | Scope, phases, estimates, parallelisation, risks, questions for sign-off                                   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)             | System shape, data model, traceability, write path, access control, sync, decision log                     |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md)             | The `/api/v1` contract shared by the mobile app, the web device layer and integrations                     |
| [docs/DEVICE_INTEGRATION.md](docs/DEVICE_INTEGRATION.md) | Zebra hardware, how a browser reaches it, and **how the connectors are built and tested with no hardware** |
| [docs/DEMO_MODE.md](docs/DEMO_MODE.md)                   | Running the whole product on a demo database with simulated devices                                        |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)                 | Deploying it, the scheduled jobs, backups, and the restore drill that proves they work                     |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md)                 | For the floor: scanning, receiving, issuing, counting, printing                                            |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)               | For administrators: setting a site up, tracking modes, recalls, reports, keeping it honest                 |
| [docs/DEVICE_SETUP.md](docs/DEVICE_SETUP.md)             | Setup sheets for scanners, printers and fixed RFID readers                                                 |

## What v1 includes

**Production-complete traceability, from the first migration.** Per-item tracking mode (`NONE`, `BATCH` or
`SERIAL`), batch and lot numbers, expiry dates with FEFO allocation and blocking, unit-level serial numbers
linked to RFID EPCs, controlled reason codes, human-readable document numbers (`RCV-2026-000123`), and a full
audit trail. Items set to `NONE` stay exactly as simple as they are today — traceability costs nothing where it
is not wanted.

**Zebra connectors, ready before the hardware.** We have no devices yet, so every adapter is written against the
real protocol — ZPL, LLRP, HID — and tested against protocol-level simulators rather than mock objects. Each has
a `selfTest()`, and a bring-up checklist turns the arrival of hardware into a day of configuration.

**Demo mode.** The same application, the same services, the same API and the same ledger transactions, against a
separate demo database with simulated devices. Every workflow demonstrable end to end with nothing plugged in —
and, once the mobile app adopts it, both clients side by side proving the shared backend rather than asserting it.

## Access tiers

- **Admin** — master data, users and roles, sites, settings, device registry, label templates, reason codes,
  numbering, audit, imports, demo reset, plus everything below.
- **User** — daily operations: scan, receive, issue, move, adjust, count, print, view stock, batches, serials
  and history.
- _(Optional)_ **Supervisor** — adds count approval, exception resolution, FEFO override, quarantine and scrap.

## Zebra hardware

Both clients drive Zebra hardware behind one abstraction. The web app reaches it in tiers, so nothing is gated
behind a specific browser or a required installation:

| Tier | Route                                                                            | Works in          | Install       |
| ---- | -------------------------------------------------------------------------------- | ----------------- | ------------- |
| 1    | HID keyboard wedge — any paired scanner, including RS5100 / RS6000 ring scanners | Every browser     | None          |
| 2    | WebHID / Web Bluetooth — symbology, battery, device control                      | Chromium          | None          |
| 3    | Zebra Browser Print — locally attached USB / Bluetooth printers                  | Chromium, Firefox | Zebra utility |
| 4    | Server-side — ZPL over TCP 9100, fixed RFID readers over LLRP / MQTT             | Every browser     | None          |

Handheld RFID sleds (RFD40 / RFD90) and belt-worn printers belong to the mobile app; fixed readers and networked
printers are driven by the server. Details in [docs/DEVICE_INTEGRATION.md](docs/DEVICE_INTEGRATION.md).

## Relationship to the mobile app

The mobile app is the same product on the warehouse floor, not a separate system. Today it is a UI-only MVP on
in-memory mock data with simulated devices (its ADR-010); its domain rules and device layer are real and
unit-tested, but its repositories are fake and reset on restart. Its roadmap (`MVP_PLAN.md` §11) lists what it
needs: a backend, auth, a local database, a sync engine and real device adapters.

**This project delivers the backend and database.** The ledger model, the movement types, all validation rules
and the SGTIN-96 EPC encoding carry over unchanged — and the mobile app's Kotlin unit tests become the
specification for the TypeScript port, so a movement means the same thing whichever client created it. The phone
later adopts the same Live/Demo switch.

## Stack

Next.js App Router · TypeScript · MySQL 8 · Prisma · NextAuth · Zod · Tailwind + shadcn/ui · SSE · Vitest ·
Playwright. Chosen to match the team's existing `madenkorea-production` app.
