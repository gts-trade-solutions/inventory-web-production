-- ---------------------------------------------------------------------------
-- Inventory App — one-time MySQL setup
--
-- Creates the two databases (live and demo) and a dedicated application user.
-- The two databases are never joined; the mode resolver picks one per request
-- (ARCHITECTURE §8, WADR-023/024).
--
-- Run as root, once per environment.
--
--   PowerShell (note: PowerShell has no "<" input redirection, so pipe instead):
--     Get-Content scripts\setup-mysql.sql | & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
--
--   Git Bash / Linux / macOS:
--     mysql -u root -p < scripts/setup-mysql.sql
--
-- CHANGE THE PASSWORD BELOW BEFORE RUNNING, then put the same value in
-- .env (URL-encode any special characters there).
-- ---------------------------------------------------------------------------

SET @app_password = 'root';

-- --- Databases -------------------------------------------------------------
-- utf8mb4 so item names, notes and operator input handle any script or emoji.
CREATE DATABASE IF NOT EXISTS `inventory`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS `inventory_demo`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Integration tests truncate between cases, so they get their own database.
-- Running them against the demo one would wipe the demo dataset every time, and
-- Demo mode is a product feature, not a scratchpad.
CREATE DATABASE IF NOT EXISTS `inventory_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- --- Application user ------------------------------------------------------
-- mysql_native_password is avoided; Prisma handles caching_sha2_password fine.
SET @sql = CONCAT('CREATE USER IF NOT EXISTS ''inventory_app''@''localhost'' IDENTIFIED BY ''', @app_password, '''');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The app owns its schema: Prisma Migrate needs DDL rights on both databases.
GRANT ALL PRIVILEGES ON `inventory`.*      TO 'inventory_app'@'localhost';
GRANT ALL PRIVILEGES ON `inventory_demo`.* TO 'inventory_app'@'localhost';
GRANT ALL PRIVILEGES ON `inventory_test`.* TO 'inventory_app'@'localhost';

-- Prisma Migrate uses a shadow database to diff migrations. Allow it to create
-- and drop temporary databases named prisma_migrate_shadow_db_*.
GRANT CREATE, DROP, ALTER, REFERENCES, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON `prisma_migrate_shadow_db_%`.* TO 'inventory_app'@'localhost';

FLUSH PRIVILEGES;

-- --- Verify ----------------------------------------------------------------
SELECT SCHEMA_NAME AS created_database
  FROM INFORMATION_SCHEMA.SCHEMATA
 WHERE SCHEMA_NAME IN ('inventory', 'inventory_demo', 'inventory_test');
