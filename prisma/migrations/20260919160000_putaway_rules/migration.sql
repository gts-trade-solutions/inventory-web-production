-- Putaway rules: where a receipt should go, when nobody has said.
--
-- Advisory by design. A rule produces a SUGGESTION on the receive form, which
-- the operator accepts or ignores; nothing here refuses a movement. The
-- operator can see the shelf and the system cannot, and a system that argues
-- with the building loses.
--
-- Matched by `priority` ascending, then by how narrow the rule is. A rule with
-- neither a category nor a tracking mode matches everything, which is how a
-- catch-all is written.
--
-- Cascades throughout: a rule is configuration, not history. If the site,
-- category or target location it depends on is removed, the rule is
-- meaningless and should go with it — unlike a movement, which must survive.

CREATE TABLE `putaway_rules` (
  `id`               CHAR(36)     NOT NULL,
  `siteId`           CHAR(36)     NOT NULL,
  `priority`         INT          NOT NULL DEFAULT 100,
  `categoryId`       CHAR(36)     NULL,
  `trackingMode`     ENUM('NONE', 'BATCH', 'SERIAL') NULL,
  `targetLocationId` CHAR(36)     NULL,
  `targetZone`       ENUM('INBOUND', 'STORAGE', 'OUTBOUND') NULL,
  `active`           BOOLEAN      NOT NULL DEFAULT true,
  `note`             VARCHAR(200) NULL,
  `createdAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3)  NOT NULL,

  INDEX `putaway_rules_siteId_active_priority_idx` (`siteId`, `active`, `priority`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `putaway_rules`
  ADD CONSTRAINT `putaway_rules_siteId_fkey`
    FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `putaway_rules_categoryId_fkey`
    FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `putaway_rules_targetLocationId_fkey`
    FOREIGN KEY (`targetLocationId`) REFERENCES `locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
