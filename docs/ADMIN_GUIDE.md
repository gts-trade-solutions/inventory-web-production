# Administering the inventory system

For administrators: setting the system up, keeping it right, and answering questions with it.

For day-to-day warehouse work see [USER_GUIDE.md](USER_GUIDE.md). For servers, backups and deployment see
[OPERATIONS.md](OPERATIONS.md).

---

## Who can do what

| Role           | Can                                                                              |
| -------------- | -------------------------------------------------------------------------------- |
| **User**       | Everything on the floor: scan, receive, issue, move, adjust, scrap, count, print |
| **Supervisor** | Also: approve counts, quarantine and release batches, override an expiry block   |
| **Admin**      | Also: master data, people, settings, templates, import, audit, demo reset        |

Roles are enforced on the server, not by hiding buttons. Someone who finds a URL they should not have still
cannot use it.

**Site scope** decides which warehouses a person can work in. It is enforced on reads and on writes, including
from the mobile app.

---

## Setting up a new site

In order, because each step needs the one before it:

1. **Master data → Sites.** Add the site. The code goes on paperwork, so keep it short.
2. **Locations.** Add the places stock sits. See below — it is worth a minute of thought.
3. **Master data → Categories.** How stock is grouped in filters and reports. Optional but cheap.
4. **Reason codes.** The controlled list behind every adjustment and scrap.
5. **People.** Accounts, roles, and which sites each person can work in.
6. **Admin → Import.** Items, barcodes and opening balances, by CSV, with a dry run first.

### Locations are a tree

Locations nest: a zone holds aisles, an aisle holds racks, a rack holds shelves — to whatever depth the
building needs.

**Stock sits in the places at the bottom.** A location that contains other locations is a grouping; you cannot
put a pallet in "Aisle A", only in a rack inside it. The system refuses it rather than making "how full is
Aisle A" a question with two answers.

**Capacity is optional and advisory.** Set it and the screens show how full a place is and suggest where to put
things. Leave it blank and nothing is assumed — a place with no capacity is *unmeasured*, not full, and the
system says "unknown" rather than guessing. It never blocks a receipt: if the goods are physically on the
shelf, the records have to be able to say so.

You can also record **weight and dimensions** on items. Where both the item and the location are measured, the
system works in real volume rather than a unit count. Where either is missing it says so. Measuring every SKU
is real work — do it where it pays, and leave the rest blank.

### Putaway rules

**Master data** lets you say where things should go: "chemicals to B-01", "everything else to storage". On a
receipt the system suggests a location and shows the reason.

Rules are matched by priority, then by how specific they are. The suggestion is never binding — the operator
can see the shelf.

---

## Items and tracking

Each item has a **tracking mode**, and it is the most consequential setting on the record:

| Mode       | Means                                    | Use when                                             |
| ---------- | ---------------------------------------- | ---------------------------------------------------- |
| **None**   | Just quantities                          | Consumables. Simple, and simple is correct for most. |
| **Batch**  | Quantities within lots, with expiry      | Anything recalled, or dated, by lot                  |
| **Serial** | Every unit tracked individually, with RFID | High value, warranty, or unit-level traceability   |

Batch and serial cost the floor time on every receipt. Turn them on where traceability is genuinely needed and
leave the rest as None — traceability costs nothing where it is not wanted.

For batch items you can set a **shelf life**, so expiry is worked out from the manufacturing date, and
**near-expiry days**, which drives the expiry board.

---

## Document numbering

**Master data → Document numbering** controls what paperwork is called: `RCV-2026-000123`.

**The next number can be raised but never lowered.** Raising skips numbers, which leaves a visible gap and is
harmless. Lowering would give a second delivery a reference already printed on filed paperwork — which surfaces
months later, in a recall, when the documents for a batch describe a different delivery.

Raising it is how you continue from a previous system.

---

## Settings that change behaviour

**Admin → Settings.** Everything there does something; nothing is decorative.

- **Expiry policy** — whether issuing expired stock is blocked outright or allowed with a supervisor override.
- **Adjustment cap** — the largest correction somebody can make in one go. It applies to bulk corrections too.
- **Count auto-approval threshold** — counts below this variance post without a supervisor. Off by default,
  which is the safe setting.

---

## Recalls

This is what the traceability is for.

1. **Batches & expiry** → find the lot, or search the batch number.
2. **Build the recall pack** — every movement of that lot, where the stock is now, every unit produced from
   it, and a reconciliation showing whether the ledger balances.
3. **Quarantine it.** From the batch list you can select several lots at once — a supplier's defect notice
   names a list, and doing them one at a time is how the twelfth gets missed.
4. Download the pack as CSV or Excel for whoever is asking.

**Quarantine does not move stock.** The units stay where they are and still count as on-hand; they simply
become unusable. Moving them would destroy the evidence of where they were.

---

## Importing data

**Admin → Import** takes CSV for items, locations and opening balances.

**Always check before committing.** The dry run reports every row — new, changed, skipped, or in error — and
writes nothing. Commit only once it reads the way you expect.

Opening balances go through the ledger as real movements, so the stock has a history from the first day rather
than appearing from nowhere.

---

## Reports and exports

**Reports** covers stock on hand, movement summary, count accuracy, stock ageing and reorder. Filters live in
the URL, so a filtered report can be bookmarked or sent to somebody.

Every report and every list exports to **CSV or Excel**. Prefer Excel when the numbers will be worked on: a CSV
is a pile of text and Excel guesses what each value is, which turns `00123` into `123` and a long barcode into
`1.23457E+12`.

Two figures deserve care:

- **Stock ageing** only ages batch-tracked stock. For an untracked item the records hold quantities, not units,
  so nothing says which ten of the twenty on the shelf arrived in March. Those appear as **Unknown** rather
  than being given a plausible wrong age.
- **Count accuracy** is scored by lines, not units, so one bulk item cannot hide a dozen real discrepancies.

---

## Keeping it honest

**Admin → Audit log** records every master-data and admin change: who, what, before, after, when. Stock changes
are not duplicated there — the movement history is already a complete record and cannot be edited.

**Admin → Settings → Stock integrity** compares the stock figures against the movement history and reports any
disagreement. The same check runs nightly on the server.

**If it reports drift, do not immediately rebuild.** A rebuild recomputes the figures and erases the evidence
of whatever caused the disagreement — which is the thing worth finding. Look first.

---

## Demo mode

Demo mode is the whole product against a separate database with simulated devices. Same screens, same rules,
same records — nothing reaches real stock or real hardware.

**Admin → Devices → Reset demo data** puts it back to a known state. It touches only the demo database.

Use it for training, for showing the system to someone, and for trying a change before doing it for real.
