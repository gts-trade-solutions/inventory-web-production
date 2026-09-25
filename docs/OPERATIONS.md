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

From `scripts/setup-mysql.sql`. It creates the first two always, and the third only when asked:

| Database          | What it is                                              | On the server?                           |
| ----------------- | ------------------------------------------------------- | ---------------------------------------- |
| `inventory`       | The real one.                                           | Yes.                                     |
| `inventory_demo`  | Demo mode — a product feature, not a scratch database.   | Yes, if `DEMO_MODE_ENABLED` is true.     |
| `inventory_test`  | Integration tests. Truncated between cases.              | No. Development machines only.           |

`inventory_test` must never exist on a production server. The tests `TRUNCATE` their way through it, and a
misconfigured `DATABASE_URL_TEST` pointing anywhere else would do the same there. The script therefore skips it
unless you pass `SET @with_test_db = 1;`, which development machines do and servers do not.

### Running it

The script **creates no users and contains no password**. User provisioning belongs to the environment: most
servers already have a deployment user shared across projects, and a second one per app is another credential to
rotate, store and leak. Name the existing user and the script grants it what it needs:

```sh
{ echo "SET @db_user = 'deploy';"; cat scripts/setup-mysql.sql; } | sudo mysql
```

Add `SET @with_test_db = 1;` to that prepended line on a development machine.

`@db_host` defaults to `localhost`. Check what your user actually exists as before assuming, because the grant
must match a host exactly:

```sh
sudo mysql -e "SELECT user, host FROM mysql.user WHERE user = 'deploy';"
```

Since MySQL 8.0, `GRANT` cannot create a user, so a host that does not exist fails loudly rather than quietly
creating a second, password-less account. Omit `@db_user` entirely and the script stops before creating anything,
with `Table 'mysql.set @db_user first - see setup-mysql.sql header' doesn't exist` — the guard working, not a
fault.

It finishes by printing the databases that exist and the privileges the user now holds on each. Expect
`inventory`, `inventory_demo` and `prisma_migrate_shadow_db_%`. That last one is easy to overlook and its absence
surfaces later as a `migrate deploy` permissions error that never mentions shadow databases.

Then put that user's existing credentials in `.env` as `DATABASE_URL`, URL-encoded.

One consequence of sharing a credential, worth stating once: its blast radius now includes this warehouse's stock
data, and rotating it affects every project that uses it. A reasonable trade for one fewer secret — but a trade.

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

### Ubuntu, nginx and pm2

Three files in the repository cover this stack. Each carries its reasoning in comments; the placeholders to
replace are marked `CHANGE ME` or named in the header.

| File                                        | Install with                                      |
| ------------------------------------------- | ------------------------------------------------- |
| [`ecosystem.config.cjs`](../ecosystem.config.cjs) | `pm2 start ecosystem.config.cjs && pm2 save`  |
| [`deploy/nginx.conf`](../deploy/nginx.conf) | copy to `/etc/nginx/sites-available/inventory`    |
| [`deploy/crontab`](../deploy/crontab)       | `crontab -u inventory deploy/crontab`             |

Three things in them are not stylistic preferences:

**One instance, fork mode.** The SSE event bus (`lib/events/bus.ts`) and the rate limiter
(`lib/api/rate-limit.ts`) both keep state in-process on `globalThis`. Under `pm2 -i max`, an event recorded by
one worker never reaches a console held open by another — nothing errors, the screen simply stops updating — and
the 10/minute per-account sign-in limit becomes 10 per worker. Both are stated single-instance assumptions.
Going wider means moving both to Redis first.

**`proxy_buffering off` on `/api/v1/stream`.** Otherwise nginx holds the event stream waiting for a body that
never ends, and the device console shows nothing while reporting no error. §8 lists the symptom because it has
been diagnosed the hard way already.

**`X-Forwarded-Proto` on the main location, and `AUTH_TRUST_HOST=true` in `.env`.** Two halves of one thing:
without them Auth.js sees plain HTTP behind the proxy and issues `http://` callbacks that fail against an
`https://` `AUTH_URL`.

One more that catches everyone: cron runs with a near-empty `PATH`, and the scheduled scripts resolve `.env`
relative to the working directory. Both jobs therefore need `PATH` set and a `cd` into the app directory — the
committed crontab does both.

### Upgrading

```sh
git pull && npm ci && npm run db:deploy && npm run build && pm2 reload inventory
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

## 9. Monitoring

### Two health endpoints, which answer different questions

| Endpoint                | Asks                              | Touches the database | Point it at                     |
| ----------------------- | --------------------------------- | -------------------- | ------------------------------- |
| `GET /api/v1/health`    | Is the web tier up?               | **No**               | Uptime monitoring, and the phone's "am I offline" check |
| `GET /api/v1/health/ready` | Would a real request work?      | Yes — `SELECT 1`     | Load balancer / container readiness probe |

Keep them apart. Liveness must not touch the database: a check that goes red whenever MySQL is briefly busy
teaches people to ignore it. Readiness must, because that is the question it exists to answer.

Conflating them is how a load balancer pulls every instance out of rotation during a thirty-second database
blip and turns a slow minute into an outage.

Readiness answers **503** when the database is unreachable, not 500 — "come back shortly" rather than "the
application is broken", which is the difference between a retry and somebody being woken up. Verified by
pointing an instance at a dead port: liveness stayed 200, readiness returned 503 in about two seconds.

### Logs

One JSON object per line, on stdout:

```json
{"level":"error","event":"health.notReady","at":"2026-09-19T12:06:19.440Z","ms":2070,"error":"Can't reach database server"}
```

`event` is a stable slug rather than a sentence, so the wording can be improved without breaking the query that
counts them. Every API failure carries the same `requestId` the caller was given — so "it failed at about ten
past three" becomes `event="api.failed" requestId="…"` rather than a grep through prose.

Fields named `password`, `token`, `secret`, `authorization` and similar are redacted at any depth before a line
is written, because a log is the copy that ends up in a third-party search index.

Run the process under something that captures stdout — systemd, pm2, a Windows service wrapper — rather than a
terminal somebody eventually closes.

### Error reporting

`report()` in `lib/log.ts` is the single seam every unexpected error goes through. **Sentry is not wired**: it
is a two-line change there (`@sentry/nextjs`, a `SENTRY_DSN`, and the commented `captureException` call), left
undone deliberately because an SDK that cannot be exercised without a DSN is a control nobody has watched work.
The structured logging above is real and is what to read in the meantime.

### What to alert on

| Signal                                       | Where it comes from                        |
| -------------------------------------------- | ------------------------------------------ |
| `npm run sweep` exits non-zero               | Projection drift — see §5                  |
| `/api/v1/health/ready` returns 503           | Database unreachable from the web tier     |
| `event="api.failed"` rate climbing           | Something is throwing that should not be   |
| `event="print.failed"`                       | A printer stopped accepting jobs           |


---

## 10. Hardware

The Zebra connectors are written against the real protocols and tested against protocol-level simulators. Until
hardware arrives, devices registered in the app run through those simulators. The bring-up checklist — what to
configure on each device, in what order, and how to tell it worked — is in
[DEVICE_INTEGRATION.md](DEVICE_INTEGRATION.md).

One thing worth repeating here: **demo mode cannot reach real hardware**. The printer and reader connectors take
the mode as a required argument rather than reading it from anywhere, so a demo session gets a simulator whatever
is registered, and a live session refuses a simulated device rather than quietly pretending.
