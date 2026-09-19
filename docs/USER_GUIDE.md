# Using the inventory system

For everyone who works the floor: receiving, picking, moving, counting and printing labels.

You do not need to read this end to end. Find what you are doing and read that bit.

---

## Signing in

Your administrator gives you an email address and a password.

If the login screen offers a choice between **Live** and **Demo**, it matters:

- **Live** is the real warehouse. What you record here is what the business believes it owns.
- **Demo** is practice. Sample data, simulated scanners, nothing real. A yellow bar across the top says
  **Demo mode** so you always know which one you are in.

Use Demo to learn. Nothing you do there can break anything.

---

## Scanning

**Scan works everywhere.** A scanner paired as a keyboard just types, and the system recognises it by how fast
the characters arrive — so you do not need to click into a box first. Point and pull the trigger.

If you have no scanner, or the barcode is damaged, the **Scan** screen has a box you can type into. Same
result.

Scan almost anything and the system works out what it is:

| You scan          | You get                                        |
| ----------------- | ---------------------------------------------- |
| An item barcode   | That item, with what is in stock and where     |
| A case barcode    | The same item, and the quantity it represents  |
| A batch label     | That batch: its expiry, its status, where it is |
| A serial label    | That exact unit and its whole history          |
| A location label  | Everything in that location                    |
| An RFID tag       | The unit it belongs to                         |

---

## Receiving stock

1. Scan the item, or find it under **Inventory**.
2. Choose **Receive**.
3. Pick where it is going.
4. Enter the quantity and press **Record**.

**The system may suggest a location.** It shows the reason — "this item is already stored here", or a rule your
administrator wrote. It may also show how full the place is. It is a suggestion: you can see the shelf and the
system cannot, so put the goods where they actually fit and change the location if the suggestion is wrong.

### If the item is batch-tracked

You will be asked for a **batch or lot number** and usually an **expiry date**. Both come off the delivery, not
out of your head — they are what makes a recall possible later.

If the item has a shelf life set, leave expiry blank and enter the manufacturing date instead; the system works
the expiry out.

### If the item is serial-tracked

Each unit is recorded individually. You can type the serial numbers, scan them, or have the system generate
them. If you are printing RFID labels, each one gets its own tag as it prints.

---

## Issuing stock

1. Scan or find the item.
2. Choose **Issue**.
3. Pick where it is coming from — only locations that actually hold it are offered.
4. Enter the quantity and press **Record**.

### The batch the system proposes

For batch-tracked items the system proposes the batch that **expires soonest** and marks it **Use first**. That
is almost always the right one: using newer stock first is how the older stock expires on the shelf.

You can choose a different batch. If you do, the reason is recorded against the movement, and some choices need
a supervisor.

**Expired and quarantined batches are marked and blocked.** If you believe a block is wrong, ask a supervisor —
do not work around it by issuing something else and correcting it later.

---

## Moving stock

**Move** takes stock from one location to another inside the same site. From, to, quantity.

Stock cannot be moved between **sites** in one step. A transfer between warehouses is an issue from one and a
receipt into the other.

---

## Adjusting and scrapping

**Adjust** corrects a quantity: you enter what is *actually* on the shelf and the system works out the
difference. **Scrap** writes stock off.

Both need a **reason** from a list your administrator maintains. The list exists so the question "why did we
lose 40 units last month" has an answer — free text cannot be counted.

Your administrator may cap how large an adjustment can be. If you hit the cap, the system says so; it is not a
fault, and a supervisor can make the correction.

---

## Counting stock

1. **Cycle counts** → start a count, choose a location and how you are counting.
2. Count: scan each item, sweep with an RFID reader, or type quantities.
3. The screen shows what is found, what is missing and what is unexpected as you go.
4. Press **Submit for approval**.

**Submitting changes no stock.** A supervisor reviews the differences and decides. This is deliberate: a
miscount posted straight to the ledger is the fastest way to lose stock accuracy.

If you count only part of a location, say so and count the rest — a count covers the whole location, so a line
nobody counted is proposed for write-off exactly like a line counted as empty. The review screen warns about
this, but it is easier to avoid than to explain.

### Approving a count (supervisors)

Open the count and review the differences line by line. **Approve and post** turns each difference into a
correction in the ledger. **Reject** sends it back with a note and changes nothing.

A count that matched exactly posts nothing, and that is the good outcome.

---

## Printing labels

**Labels & printing** → choose an item, batch, serial or location, pick a template, preview, print.

The preview is drawn from the actual bytes going to the printer, so what you see is what the printer was told
to produce. Reprints are in the history — if three labels smudged, reprint those three.

"Sent" means the printer accepted the job. It does not mean a label came out. Check the printer.

---

## When something looks wrong

| What you see                            | What it means                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Stock showing as a **negative** number   | More was issued than the system knew about — usually a sync from a phone that was offline. A supervisor resolves it. Do not "fix" it with an adjustment first; the difference is the evidence. |
| **Low** badge on an item                 | At or below its reorder point.                                                |
| A batch marked **Quarantine**            | Frozen pending a decision. It stays where it is and still counts as stock.    |
| **Expired**                              | Past its expiry date. It cannot be issued.                                    |
| A movement you recorded is not there     | If you were offline, it is queued and will sync. Check the pending count.     |

**Nothing you record can be edited or deleted.** A mistake is corrected by recording a correction, and both
stay in the history. That is what makes the records trustworthy — including for you, when somebody asks why a
number changed.

---

## Working offline

On a phone, work continues when the network drops. Movements queue and a badge shows how many are waiting.
They sync when the connection returns, and each one gets its own verdict — accepted, duplicate, or flagged for
a supervisor.

**Keep working.** The queue is not a fault, and nothing is lost by carrying on.
