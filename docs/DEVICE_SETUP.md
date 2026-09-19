# Scanner and printer setup

Practical sheets for whoever unboxes the hardware. One page per device type.

The engineering detail — protocols, connectors, how they were tested without hardware — is in
[DEVICE_INTEGRATION.md](DEVICE_INTEGRATION.md). This is what to do on the day.

---

## Scanner

Any Zebra scanner that can present as a keyboard works, with no driver and no setup in the application. That
is the floor, and it is a real one rather than a fallback.

### 1. Put it in HID keyboard mode

Scan the **HID keyboard** configuration barcode from the scanner's Quick Start guide, or set it in 123Scan.

Models this covers: RS5100, RS6000, RS5000 ring scanners; DS2278, DS3608, DS3678, LI3678 handhelds; the
integrated scanner on a TC52/TC57/TC22 or MC3300.

### 2. Set the terminator to Enter

The application recognises a scan by the burst of characters ending in Enter. Without a terminator the scan
never completes; with Tab it moves focus instead.

### 3. Pair it

Bluetooth models: scan the pairing barcode on the cradle, or pair through the operating system. Corded and USB
cradle models need nothing.

### 4. Check it

Open **Scan** in the application and scan any product barcode. The item should appear without you clicking
into a box first.

> **If characters appear in a field instead of a scan being recognised**, the scanner is typing too slowly to
> be told apart from a person. Reduce the inter-character delay in 123Scan — 0 ms is right.

### Optional: direct connection

In Chrome or Edge, **Scan → Connect a scanner** claims the device directly and captures the symbology as well
as the data. It is a bonus, not a requirement — everything works without it, and the browser will ask
permission each time on some systems.

### Setup sheet

| Setting                | Value            | Why                                          |
| ---------------------- | ---------------- | --------------------------------------------- |
| Mode                   | HID keyboard     | Works in every browser with no driver         |
| Terminator             | Enter (CR)       | How a scan is recognised as finished          |
| Inter-character delay  | 0 ms             | Slow typing is mistaken for a person          |
| Caps lock override     | On               | Prevents case corruption on some systems      |
| Symbologies            | EAN-13, Code 128, ITF-14 at minimum | What the labels use          |

---

## Networked printer

The server sends ZPL directly to the printer over the network. Nothing is installed on the workstation.

### 1. Give it a fixed address

A static IP, or a DHCP reservation. If the address changes, printing stops — the application holds the address
it was given.

### 2. Confirm port 9100 is reachable **from the server**

Not from your laptop. The server is what connects.

```sh
# From the server:
telnet 10.0.4.21 9100
```

If that does not connect, nothing else here will work. It is a firewall or VLAN question, not an application
one.

### 3. Register it

**Devices → Add a printer or reader.** Connection **Network**, address `10.0.4.21:9100`.

### 4. Run the self-test

**Devices → Self-test.** It reports each step separately, and the detail matters more than the verdict:

| Step               | What a good result looks like                               |
| ------------------ | ------------------------------------------------------------ |
| Open socket        | "Connected to 10.0.4.21 on port 9100."                       |
| Query status (~HS) | "The printer answered and reports no problems."              |
| Print a test label | "179 bytes accepted. Check that a label came out."           |

A step can come back **unproven** rather than pass or fail — for instance a printer that answers the status
query without reporting paper or head status. That is not a failure, and it is not a pass either; it means
that particular check told you nothing, and the message says what to do about it.

**"Sent" is not "printed".** The socket closing means the printer took the bytes. Look at the printer.

### 5. Calibrate media

Run the printer's own media calibration with the label stock you will actually use, then check darkness and
speed against a printed label. Compare it to the on-screen preview — they should match.

### RFID printers

Confirm `^RFW` encoding works, check tag placement against your label stock, and set write power. Print one,
then read the tag back to confirm the EPC matches the unit it was printed for.

### Setup sheet

| Setting        | Value                          |
| -------------- | ------------------------------ |
| Address        | Static IP or DHCP reservation  |
| Port           | 9100 (raw ZPL)                 |
| Reachable from | The **server**, not the client |
| Media          | Calibrated against real stock  |
| Darkness/speed | Tuned, and recorded here       |

---

## USB printer at a workstation

A printer plugged into one machine cannot be reached by the server. Install **Zebra Browser Print** on that
workstation; the application detects it and prints through it.

Prefer networked printers where there is a choice — one address, no per-workstation installation, and the
server can print without anybody being logged in.

---

## Fixed RFID reader

### 1. Address and network

Static IP. The server connects on **port 5084** (LLRP). Confirm reachability from the server, as with the
printer.

### 2. Register it

**Devices → Add a printer or reader.** Connection **Network**, address `10.0.4.40:5084`.

### 3. Run the self-test

| Step                  | What a good result looks like                    |
| --------------------- | ------------------------------------------------- |
| Connect               | "Connected to 10.0.4.40 on port 5084."           |
| Read capabilities     | "Answered with N bytes of capabilities."          |
| Inventory for 5 seconds | "Saw 3 distinct tags in 12 reads."              |

**"Ran, but saw no tags" is reported as unproven, not as a pass.** The reader answered and the sweep
completed — but the one thing that step exists to demonstrate did not happen. Put known tagged stock in range
and run it again. If it is already in range, check the antenna cables, transmit power and read zone.

### 4. Tune it

Run a controlled read of a known set of tags and measure what it misses and what it picks up from
neighbouring aisles. Adjust transmit power and filtering until both are acceptable, then record the settings
against the device.

### Setup sheet

| Setting        | Value                          |
| -------------- | ------------------------------ |
| Address        | Static IP                      |
| Port           | 5084 (LLRP)                    |
| Reachable from | The **server**                 |
| Antennas       | Which ports, covering what     |
| Transmit power | Tuned, and recorded here       |
| Stray-tag rate | Measured, and acceptable       |

---

## Before hardware arrives

`npm run bringup` prints what a bring-up record looks like — the real connectors run against simulators,
including the failures: a printer that connects then says nothing, an address with nothing on it, a reader
that sees no tags.

Read it before the boxes are opened. Deciding whether a real result looks normal is far easier against a
known-good example than from scratch at nine in the morning with a pallet of Zebras.
