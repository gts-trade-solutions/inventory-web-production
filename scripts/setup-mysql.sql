-- ---------------------------------------------------------------------------
-- Inventory App — one-time MySQL setup
--
-- Creates the databases and grants an EXISTING application user access to them.
-- The live and demo databases are never joined; the mode resolver picks one per
-- request (ARCHITECTURE §8, WADR-023/024).
--
-- Run as root, once per environment.
--
-- ---------------------------------------------------------------------------
-- This script does not create users, and contains no password.
-- ---------------------------------------------------------------------------
--
-- User provisioning is an environment concern, not this application's. Most
-- servers already have a deployment user shared across projects, and creating a
-- second one per app means another credential to rotate, store and leak. So this
-- script grants to a user you name and stops there.
--
-- The consequence, worth saying once: a shared credential's blast radius now
-- includes this warehouse's stock data, and rotating it affects every project
-- that uses it. That is a reasonable trade for one fewer secret, but it is a
-- trade.
--
--   Linux / macOS / Git Bash — production:
--     { echo "SET @db_user = 'deploy';"; cat scripts/setup-mysql.sql; } | sudo mysql
--
--   ...and on a development machine, which also wants the test database:
--     { echo "SET @db_user = 'deploy'; SET @with_test_db = 1;"
--       cat scripts/setup-mysql.sql; } | mysql -u root -p
--
--   PowerShell (no "<" redirection, so build the input and pipe it):
--     @("SET @db_user = 'deploy';", "SET @with_test_db = 1;") +
--       (Get-Content scripts\setup-mysql.sql) |
--       & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
--
-- @db_host defaults to 'localhost'. Check which hosts your user exists for
-- before assuming, because the grant must match one of them exactly:
--
--     SELECT user, host FROM mysql.user WHERE user = 'deploy';
--
-- Since MySQL 8.0, GRANT cannot create a user, so naming a host that does not
-- exist fails loudly rather than quietly creating a second, password-less
-- account. That is the behaviour this script relies on instead of checking.
--
-- Then put that user's existing credentials in .env as DATABASE_URL, URL-encoding
-- any special characters: @ becomes %40, # becomes %23, : becomes %3A. A raw @
-- truncates the host and produces a connection error that blames the wrong thing.
-- ---------------------------------------------------------------------------

SET @db_host = IFNULL(@db_host, 'localhost');

-- --- Guard -----------------------------------------------------------------
--
-- Without @db_user there is no sensible default, so fail with an instruction.
-- The prepared statement below selects from a table whose NAME IS THE MESSAGE:
--
--   ERROR 1146 (42S02): Table 'mysql.set @db_user first - see setup-mysql.sql
--                       header' doesn't exist
--
-- Two details are load-bearing, both found by testing rather than reasoning:
--
--   * Qualified with `mysql`. Unqualified, the error is "No database selected",
--     because `sudo mysql < file` has no default database — which is exactly how
--     this runs. The useful message never appeared.
--   * The name is under 64 characters. Identifiers cap there, and a longer first
--     draft became "Identifier name is too long".
--
-- SIGNAL SQLSTATE would give an exact message, but it is not supported in the
-- prepared statement protocol and so cannot be used inside an IF like this.
SET @sql = IF(
  @db_user IS NULL OR @db_user = '',
  'SELECT 1 FROM `mysql`.`SET @db_user FIRST - see setup-mysql.sql header`',
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- Databases -------------------------------------------------------------
-- utf8mb4 so item names, notes and operator input handle any script or emoji.
CREATE DATABASE IF NOT EXISTS `inventory`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS `inventory_demo`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- --- Grants ----------------------------------------------------------------
--
-- The app owns its schema: Prisma Migrate needs DDL rights, not just DML.
-- Quotes in an identifier are doubled, so an unusual user name cannot end the
-- string early and change the meaning of the statement.
SET @who = CONCAT('''', REPLACE(@db_user, '''', ''''''), '''@''', REPLACE(@db_host, '''', ''''''), '''');

SET @sql = CONCAT('GRANT ALL PRIVILEGES ON `inventory`.* TO ', @who);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = CONCAT('GRANT ALL PRIVILEGES ON `inventory_demo`.* TO ', @who);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Prisma Migrate diffs migrations against a shadow database it creates and drops
-- itself, named prisma_migrate_shadow_db_*. Without this grant, `migrate deploy`
-- fails with a permissions error that does not mention shadow databases at all.
-- A shared deployment user may already have it; granting again is harmless.
SET @sql = CONCAT(
  'GRANT CREATE, DROP, ALTER, REFERENCES, INDEX, SELECT, INSERT, UPDATE, DELETE ',
  'ON `prisma_migrate_shadow_db_%`.* TO ', @who
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- Test database — opt in, never on a server ------------------------------
--
-- Integration tests TRUNCATE their way through this database between cases. It
-- gets its own, because running them against the demo one would wipe the demo
-- dataset every time and Demo mode is a product feature, not a scratchpad.
--
-- Opt-in because the failure mode is asymmetric: a developer without it gets a
-- clear error from the test runner, while a production box that has it needs only
-- a stale DATABASE_URL_TEST for a test run to truncate live data. Absent by
-- default is the safe direction.
SET @sql = IF(
  @with_test_db = 1,
  'CREATE DATABASE IF NOT EXISTS `inventory_test` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  'SELECT ''inventory_test: skipped (set @with_test_db = 1 on a dev machine)'' AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  @with_test_db = 1,
  CONCAT('GRANT ALL PRIVILEGES ON `inventory_test`.* TO ', @who),
  'DO 0'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

FLUSH PRIVILEGES;

-- --- Verify ----------------------------------------------------------------
SELECT SCHEMA_NAME AS created_database
  FROM INFORMATION_SCHEMA.SCHEMATA
 WHERE SCHEMA_NAME IN ('inventory', 'inventory_demo', 'inventory_test');

-- What the user can now reach. Expect one row per database granted above.
SELECT TABLE_SCHEMA AS granted_database, COUNT(*) AS privileges_held
  FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES
 WHERE GRANTEE = CONCAT('''', @db_user, '''@''', @db_host, '''')
 GROUP BY TABLE_SCHEMA
 ORDER BY TABLE_SCHEMA;
