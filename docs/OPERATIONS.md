# Operations

Deploying and running the inventory web app. Written for whoever puts it on a server and keeps it there.

Everything below has been run. Where a command's output is quoted, that is what it actually printed.

---

## 1. What it needs

| Thing    | Version                | Notes                                                                    |
| -------- | ---------------------- | ------------------------------------------------------------------------ |
| Node     | 22 LTS or newer        | Built and tested on 22.x.                                                |
| MySQL    | 8.0 or newer           | 8.0.43 in development. `utf8mb4`.                                        |
| Disk     | Small                  | The database is the only thing that grows; the ledger is append-only.    |
| Memory   | 1 GB for the app       | Plus whatever MySQL is given.                                            |

MySQL client tools (`mysql`, `mysqldump`) must be on the server for the backup scripts. They are not needed by
the application itself.

**One application instance.** Two things in this app hold state in process memory: the event bus that feeds the
live device console, and the rate limiter. Behind two instances, half the SSE clients would miss half the
events, and the effective rate limit would double. Neither fails loudly. If a second instance is ever needed,
both have to move to a shared store first — see `lib/events/bus.ts` and `lib/api/rate-limit.ts`, which both say
so at the top.

---

## 2. Databases

Three, from `scripts/setup-mysql.sql`:

| Database          | What it is                                              | On the server?                           |
| ----------------- | ------------------------------------------------------- | ---------------------------------------- |
| `inventory`       | The real one.                                           | Yes.                                     |
| `inventory_demo`  | Demo mode — a product feature, not a scratch database.   | Yes, if `DEMO_MODE_ENABLED` is true.     |
| `inventory_test`  | Integration tests. Truncated between cases.              | No. Development machines only.           |

`inventory_test` must never exist on a production server. The tests `TRUNCATE` their way through it, and a
misconfigured `DATABASE_URL_TEST` pointing anywhere else would do the same there.

---

## 3. Environment

Copy `.env.example` to `.env` and fill it in. It documents every variable; the ones that decide whether a
deployment is sound:

- **`AUTH_SECRET` and `JWT_SIGNING_KEY`** — generate both, and make them different. `AUTH_SECRET` signs browser
  sessions; `JWT_SIGNING_KEY` signs the device-bound tokens the mobile app carries. One key doing both jobs
  means a stolen session cookie is also a device token.
- **`AUTH_URL`** — the public URL, with the right scheme. Auth.js builds callback URLs from it.
- **`DEMO_MODE_ENABLED`** — `false` if demo mode should not be reachable in production. The sign-in endpoint
  refuses `mode: DEMO` outright when it is off; it is not merely hidden in the UI.
- **`DATABASE_URL_TEST`** — leave it unset in production. See above.

Passwords in a `DATABASE_URL` must be URL-encoded: `@` → `%40`, `#` → `%23`, `:` → `%3A`. A raw `@` silently
truncates the host and produces a connection error that blames the wrong thing.

---

## 4. Deploying

```sh
npm ci
npm run db:deploy        # prisma migrate deploy — applies pending migrations, creates nothing new
npm run build
npm start                # listens on 3000; put a reverse proxy in front for TLS
```

`db:deploy`, not `db:migrate`. `migrate dev` is a development command: it will offer to reset the database when
it finds history it does not like, and on a production database that offer should never be on the table.

**Migrate before starting the new build, not after.** The running instance is the old code; a new column it
does not know about is harmless, a missing one is not.

### Upgrading

```sh
git pull && npm ci && npm run db:deploy && npm run build && npm start
```

Take a backup first (§6). Not because migrations usually go wrong, but because the one time it matters is the
time nobody took one.

---

## 5. Scheduled work

### The nightly sweep — required

```sh
npm run sweep            # the live database
npm run sweep -- demo
```

Two jobs. It compares `stock_levels` against the ledger and reports any disagreement, and it marks batches whose
expiry date has passed. The projection agreeing with the ledger is the system's central claim about itself; until
this runs on a schedule, the only thing that has ever checked it is a test on a throwaway database.

It **exits non-zero when it finds drift**, so cron's own failure mail is the alert and there is nothing else to
configure. Verified by injecting seven units of drift into a projection row:

```
2026-09-18T10:51:25.080Z sweep DEMO: drift=1 expired=0 17ms
  drift item=00d3db92-… location=f296fa41-… projected=16 ledger=9

1 row(s) of drift. Investigate before rebuilding: a rebuild erases the evidence of whatever caused it.
exit=1
```

crontab, 02:00 daily:

```cron
0 2 * * *  cd /srv/inventory-web-app && /usr/bin/npm run sweep >> /var/log/inventory/sweep.log 2>&1
```

Windows Task Scheduler:

```
schtasks /create /tn "Inventory nightly sweep" /tr "cmd /c cd /d C:\srv\inventory-web-app && npm run sweep" /sc daily /st 02:00
```

It runs the service directly against the database rather than calling `POST /api/v1/maintenance/sweep`. The
endpoint exists and does the same work, but driving it from cron would mean storing an administrator's password
where cron can read it — a full-rights account in plain text so a scheduled job can call a URL on the machine it
is already running on. The script needs the database, which the server has anyway, and no account at all.

Running it twice changes nothing: it reports drift rather than repairing it, and marking an expired batch
expired again is a no-op.

**When it reports drift, do not immediately rebuild.** A rebuild recomputes the projection from the ledger and
erases the evidence of whatever caused the disagreement — which is the thing worth finding. The rebuild is in
Admin → Settings → Maintenance, and it is audited.

### Backups — required

See §6. Nightly, before the sweep.

---

## 6. Backups, and proving they work

```sh
npm run backup                # the live database → backups/inventory-<timestamp>.sql
npm run backup -- demo
```

`mysqldump --single-transaction`, so a backup taken mid-shift does not stop the shift. Routines, triggers and
events are included — they are part of the schema, and a restore without them looks fine until something calls
one. The password goes to `mysqldump` through its environment, never as an argument, because arguments are
visible in the process list to every user on the machine.

The script checks the dump ends with mysqldump's own completion marker before reporting success. Exiting zero
is not the same as finishing: a connection dropped mid-dump leaves a plausible-looking `.sql` and a clean exit
code.

`backups/` is in `.gitignore`. A dump is a complete copy of the database, password hashes included; it belongs
wherever the organisation keeps its other backups, and not in the repository.

Nightly, 01:30 — before the sweep, so the backup is of the state the sweep then reports on:

```cron
30 1 * * *  cd /srv/inventory-web-app && /usr/bin/npm run backup >> /var/log/inventory/backup.log 2>&1
```

### Restoring

```sh
npm run restore -- backups/inventory-2026-09-18-01-30-00.sql inventory
```

The target database is named explicitly as the second argument. It is never inferred from the dump, and
restoring over the live database additionally requires `RESTORE_ALLOW_LIVE=yes` in the environment. That guard
is not there to forbid a production restore — it is a real operation people have to perform — only to make sure
it is being done deliberately rather than by a command recalled from shell history.

### The restore drill

```sh
npm run restore:verify            # round-trips the demo database
npm run restore:verify -- live    # or the live one; read-only against it
```

This is the part that matters. It backs the database up, restores it into a scratch database, compares every
table's row count **and** its `CHECKSUM TABLE`, then drops the scratch database and deletes the dump. A backup
that has never been restored is a file of unknown value: a dump truncated at 40 MB, a missing table, a
character set that mangles every non-ASCII name — all of them produce a plausible `.sql` and a zero exit code.

Both databases pass — run on 2026-09-18, so the row counts are only whatever was in them that day:

```
Restore verified: 26 tables, 267 rows, contents identical by checksum.   # inventory_demo
Restore verified: 26 tables, 45 rows, contents identical by checksum.    # inventory
```

And the check has been confirmed to fail when it should. A copy was damaged three ways and the comparison
caught each one:

| Damage                             | Caught by       |
| ---------------------------------- | --------------- |
| One row deleted                    | Row count       |
| One field changed, same row count  | **Checksum**    |
| A whole table dropped              | Table list      |

The middle row is why the checksum is there: a row count alone would have waved it through.

Run the drill monthly, and after any change to the schema or the MySQL version. `KEEP_BACKUP=yes` keeps the
dump it took instead of deleting it.

---

## 7. Checking a deployment

After deploying, against the running server:

```sh
npm run smoke -- https://inventory.example.com        # a real browser, every main screen
npm run check:api -- https://inventory.example.com    # the /api/v1 contract
```

Both drive the real thing — the smoke test runs an actual browser, because `curl` returning HTML proves
nothing about a page that renders client-side.

Note that `check:api` exercises sign-in repeatedly. Running it twice in quick succession against the same
account will trip the per-account rate limit (10/minute), which is the limiter working, not a fault.

Before committing anything, on a development machine:

```sh
npm run verify        # typecheck, lint, client boundaries, guards, tests
npm run build:verify  # a real production build, in .next-prod
```

The production build has caught at least one bug that nothing else could: a module-level singleton that is
instantiated once per bundle in production and once per process in development.

---

## 8. When something is wrong

| Symptom                                     | Look at                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Sweep mails about drift                     | The item and location it names. Find the cause before rebuilding — the rebuild erases it.                                      |
| Nobody can sign in, all at once             | The per-address sign-in limit (120/min) — a whole site behind one NAT. Per-account is 10/min and cannot be tripped by others.   |
| The device console shows nothing            | SSE. Check the proxy is not buffering `text/event-stream`, and that only one app instance is running.                          |
| A printer reports "head open" and is closed | `~HS` parsing, `lib/devices/server/tcp-printer.ts`. Was wrong once already.                                                     |
| Demo data looks wrong                       | Admin → Settings → Reset demo. It reseeds `inventory_demo` and touches nothing else.                                           |
| A migration failed halfway                  | Restore the backup into a scratch database first and look at it there. Do not run `migrate dev` against production.            |

Logs go to stdout. Run it under something that captures them — systemd, pm2, a Windows service wrapper — rather
than a terminal somebody eventually closes.

---

## 9. Hardware

The Zebra connectors are written against the real protocols and tested against protocol-level simulators. Until
hardware arrives, devices registered in the app run through those simulators. The bring-up checklist — what to
configure on each device, in what order, and how to tell it worked — is in
[DEVICE_INTEGRATION.md](DEVICE_INTEGRATION.md).

One thing worth repeating here: **demo mode cannot reach real hardware**. The printer and reader connectors take
the mode as a required argument rather than reading it from anywhere, so a demo session gets a simulator whatever
is registered, and a live session refuses a simulated device rather than quietly pretending.
