-- CreateTable
CREATE TABLE `sites` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,
    `deletedAt` DATETIME(6) NULL,

    UNIQUE INDEX `sites_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `parentId` CHAR(36) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,
    `deletedAt` DATETIME(6) NULL,

    INDEX `categories_parentId_idx`(`parentId`),
    UNIQUE INDEX `categories_name_parentId_key`(`name`, `parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `items` (
    `id` CHAR(36) NOT NULL,
    `sku` VARCHAR(64) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `categoryId` CHAR(36) NULL,
    `unit` VARCHAR(24) NOT NULL,
    `reorderPoint` INTEGER NOT NULL DEFAULT 0,
    `maxLevel` INTEGER NULL,
    `trackingMode` ENUM('NONE', 'BATCH', 'SERIAL') NOT NULL DEFAULT 'NONE',
    `expiryRequired` BOOLEAN NOT NULL DEFAULT false,
    `shelfLifeDays` INTEGER NULL,
    `nearExpiryDays` INTEGER NOT NULL DEFAULT 30,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,
    `deletedAt` DATETIME(6) NULL,

    UNIQUE INDEX `items_sku_key`(`sku`),
    INDEX `items_updatedAt_idx`(`updatedAt`),
    INDEX `items_categoryId_idx`(`categoryId`),
    INDEX `items_trackingMode_idx`(`trackingMode`),
    INDEX `items_active_name_idx`(`active`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_barcodes` (
    `id` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `barcode` VARCHAR(64) NOT NULL,
    `type` ENUM('EAN13', 'ITF14', 'CODE128', 'QR', 'OTHER') NOT NULL DEFAULT 'EAN13',
    `packSize` INTEGER NOT NULL DEFAULT 1,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    UNIQUE INDEX `item_barcodes_barcode_key`(`barcode`),
    INDEX `item_barcodes_itemId_idx`(`itemId`),
    INDEX `item_barcodes_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `locations` (
    `id` CHAR(36) NOT NULL,
    `siteId` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `zone` ENUM('INBOUND', 'STORAGE', 'OUTBOUND') NOT NULL DEFAULT 'STORAGE',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,
    `deletedAt` DATETIME(6) NULL,

    INDEX `locations_updatedAt_idx`(`updatedAt`),
    INDEX `locations_zone_idx`(`zone`),
    UNIQUE INDEX `locations_siteId_code_key`(`siteId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batches` (
    `id` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `batchNo` VARCHAR(64) NOT NULL,
    `mfgDate` DATE NULL,
    `expiryDate` DATE NULL,
    `supplierRef` VARCHAR(120) NULL,
    `status` ENUM('ACTIVE', 'QUARANTINE', 'EXPIRED', 'BLOCKED', 'CONSUMED') NOT NULL DEFAULT 'ACTIVE',
    `notes` TEXT NULL,
    `receivedAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    INDEX `batches_expiryDate_idx`(`expiryDate`),
    INDEX `batches_itemId_expiryDate_idx`(`itemId`, `expiryDate`),
    INDEX `batches_status_idx`(`status`),
    INDEX `batches_updatedAt_idx`(`updatedAt`),
    UNIQUE INDEX `batches_itemId_batchNo_key`(`itemId`, `batchNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `serial_units` (
    `id` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `serialNo` VARCHAR(64) NOT NULL,
    `batchId` CHAR(36) NULL,
    `epc` CHAR(24) NULL,
    `status` ENUM('IN_STOCK', 'ISSUED', 'SCRAPPED', 'QUARANTINE') NOT NULL DEFAULT 'IN_STOCK',
    `locationId` CHAR(36) NULL,
    `warrantyUntil` DATE NULL,
    `receivedAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `issuedAt` DATETIME(6) NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    UNIQUE INDEX `serial_units_epc_key`(`epc`),
    INDEX `serial_units_itemId_status_idx`(`itemId`, `status`),
    INDEX `serial_units_locationId_idx`(`locationId`),
    INDEX `serial_units_batchId_idx`(`batchId`),
    INDEX `serial_units_updatedAt_idx`(`updatedAt`),
    UNIQUE INDEX `serial_units_itemId_serialNo_key`(`itemId`, `serialNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `movements` (
    `id` CHAR(36) NOT NULL,
    `docNo` VARCHAR(32) NOT NULL,
    `siteId` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `type` ENUM('RECEIVE', 'ISSUE', 'MOVE', 'ADJUST', 'COUNT', 'SCRAP') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `batchId` CHAR(36) NULL,
    `fromLocationId` CHAR(36) NULL,
    `toLocationId` CHAR(36) NULL,
    `reasonCodeId` CHAR(36) NULL,
    `note` TEXT NULL,
    `reference` VARCHAR(120) NULL,
    `occurredAt` DATETIME(6) NOT NULL,
    `recordedAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `userId` CHAR(36) NULL,
    `deviceId` CHAR(36) NULL,
    `countSessionId` CHAR(36) NULL,
    `source` ENUM('WEB', 'MOBILE', 'IMPORT', 'ERP') NOT NULL DEFAULT 'WEB',

    UNIQUE INDEX `movements_docNo_key`(`docNo`),
    INDEX `movements_itemId_occurredAt_idx`(`itemId`, `occurredAt`),
    INDEX `movements_siteId_recordedAt_idx`(`siteId`, `recordedAt`),
    INDEX `movements_recordedAt_idx`(`recordedAt`),
    INDEX `movements_batchId_idx`(`batchId`),
    INDEX `movements_countSessionId_idx`(`countSessionId`),
    INDEX `movements_type_idx`(`type`),
    INDEX `movements_deviceId_idx`(`deviceId`),
    INDEX `movements_fromLocationId_idx`(`fromLocationId`),
    INDEX `movements_toLocationId_idx`(`toLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `movement_serials` (
    `movementId` CHAR(36) NOT NULL,
    `serialUnitId` CHAR(36) NOT NULL,

    INDEX `movement_serials_serialUnitId_idx`(`serialUnitId`),
    PRIMARY KEY (`movementId`, `serialUnitId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_levels` (
    `itemId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `batchId` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `updatedAt` DATETIME(6) NOT NULL,

    INDEX `stock_levels_locationId_idx`(`locationId`),
    INDEX `stock_levels_quantity_idx`(`quantity`),
    INDEX `stock_levels_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`itemId`, `locationId`, `batchId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `count_sessions` (
    `id` CHAR(36) NOT NULL,
    `docNo` VARCHAR(32) NOT NULL,
    `siteId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `method` ENUM('RFID', 'BARCODE', 'MANUAL') NOT NULL DEFAULT 'BARCODE',
    `status` ENUM('DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'COUNTING',
    `startedById` CHAR(36) NOT NULL,
    `startedAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `submittedAt` DATETIME(6) NULL,
    `approvedById` CHAR(36) NULL,
    `approvedAt` DATETIME(6) NULL,
    `rejectedNote` TEXT NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    UNIQUE INDEX `count_sessions_docNo_key`(`docNo`),
    INDEX `count_sessions_status_idx`(`status`),
    INDEX `count_sessions_locationId_idx`(`locationId`),
    INDEX `count_sessions_siteId_startedAt_idx`(`siteId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `count_lines` (
    `sessionId` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `batchId` CHAR(36) NOT NULL,
    `expected` INTEGER NOT NULL,
    `counted` INTEGER NOT NULL,

    INDEX `count_lines_itemId_idx`(`itemId`),
    INDEX `count_lines_batchId_idx`(`batchId`),
    PRIMARY KEY (`sessionId`, `itemId`, `batchId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `count_tags` (
    `id` CHAR(36) NOT NULL,
    `sessionId` CHAR(36) NOT NULL,
    `epc` CHAR(24) NOT NULL,
    `serialUnitId` CHAR(36) NULL,
    `itemId` CHAR(36) NULL,
    `rssi` INTEGER NULL,
    `readAt` DATETIME(6) NOT NULL,

    INDEX `count_tags_serialUnitId_idx`(`serialUnitId`),
    UNIQUE INDEX `count_tags_sessionId_epc_key`(`sessionId`, `epc`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(200) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `passwordHash` VARCHAR(120) NOT NULL,
    `role` ENUM('ADMIN', 'SUPERVISOR', 'USER') NOT NULL DEFAULT 'USER',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `defaultSiteId` CHAR(36) NULL,
    `lastLoginAt` DATETIME(6) NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,
    `deletedAt` DATETIME(6) NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_active_idx`(`active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_sites` (
    `userId` CHAR(36) NOT NULL,
    `siteId` CHAR(36) NOT NULL,

    INDEX `user_sites_siteId_idx`(`siteId`),
    PRIMARY KEY (`userId`, `siteId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `deviceId` CHAR(36) NULL,
    `expiresAt` DATETIME(6) NOT NULL,
    `revokedAt` DATETIME(6) NULL,
    `replacedById` CHAR(36) NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `refresh_tokens_tokenHash_key`(`tokenHash`),
    INDEX `refresh_tokens_userId_idx`(`userId`),
    INDEX `refresh_tokens_deviceId_idx`(`deviceId`),
    INDEX `refresh_tokens_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `devices` (
    `id` CHAR(36) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `kind` ENUM('SCANNER', 'RFID_READER', 'PRINTER', 'MOBILE_COMPUTER') NOT NULL,
    `vendor` VARCHAR(60) NULL,
    `model` VARCHAR(60) NULL,
    `serial` VARCHAR(120) NULL,
    `connection` ENUM('BLUETOOTH', 'USB', 'NETWORK', 'SIMULATED') NOT NULL DEFAULT 'SIMULATED',
    `address` VARCHAR(120) NULL,
    `siteId` CHAR(36) NULL,
    `assignedUserId` CHAR(36) NULL,
    `lastSeenAt` DATETIME(6) NULL,
    `appVersion` VARCHAR(40) NULL,
    `firmware` VARCHAR(60) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    INDEX `devices_kind_idx`(`kind`),
    INDEX `devices_siteId_idx`(`siteId`),
    INDEX `devices_lastSeenAt_idx`(`lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `label_templates` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` ENUM('ITEM', 'BATCH', 'SERIAL', 'LOCATION', 'PALLET') NOT NULL DEFAULT 'ITEM',
    `zplBody` TEXT NOT NULL,
    `widthMm` INTEGER NOT NULL DEFAULT 100,
    `heightMm` INTEGER NOT NULL DEFAULT 50,
    `dpi` INTEGER NOT NULL DEFAULT 203,
    `rfidEncode` BOOLEAN NOT NULL DEFAULT false,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    INDEX `label_templates_kind_active_idx`(`kind`, `active`),
    INDEX `label_templates_updatedAt_idx`(`updatedAt`),
    UNIQUE INDEX `label_templates_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `print_jobs` (
    `id` CHAR(36) NOT NULL,
    `docNo` VARCHAR(32) NOT NULL,
    `templateId` CHAR(36) NOT NULL,
    `printerDeviceId` CHAR(36) NULL,
    `payloadZpl` TEXT NOT NULL,
    `copies` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('QUEUED', 'SENT', 'CONFIRMED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `error` TEXT NULL,
    `itemId` CHAR(36) NULL,
    `batchId` CHAR(36) NULL,
    `serialUnitId` CHAR(36) NULL,
    `locationId` CHAR(36) NULL,
    `epc` CHAR(24) NULL,
    `userId` CHAR(36) NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `sentAt` DATETIME(6) NULL,

    UNIQUE INDEX `print_jobs_docNo_key`(`docNo`),
    INDEX `print_jobs_createdAt_idx`(`createdAt`),
    INDEX `print_jobs_status_idx`(`status`),
    INDEX `print_jobs_itemId_idx`(`itemId`),
    INDEX `print_jobs_serialUnitId_idx`(`serialUnitId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `epc_serial_blocks` (
    `id` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `deviceId` CHAR(36) NULL,
    `serialFrom` BIGINT NOT NULL,
    `serialTo` BIGINT NOT NULL,
    `consumedTo` BIGINT NULL,
    `allocatedAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `expiresAt` DATETIME(6) NULL,

    INDEX `epc_serial_blocks_itemId_serialTo_idx`(`itemId`, `serialTo`),
    INDEX `epc_serial_blocks_deviceId_idx`(`deviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reason_codes` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `appliesTo` ENUM('ADJUST', 'SCRAP', 'COUNT', 'QUARANTINE') NOT NULL,
    `requiresNote` BOOLEAN NOT NULL DEFAULT false,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    UNIQUE INDEX `reason_codes_code_key`(`code`),
    INDEX `reason_codes_appliesTo_active_idx`(`appliesTo`, `active`),
    INDEX `reason_codes_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `number_sequences` (
    `key` VARCHAR(16) NOT NULL,
    `period` VARCHAR(16) NOT NULL,
    `prefix` VARCHAR(16) NOT NULL,
    `nextValue` INTEGER NOT NULL DEFAULT 1,
    `padding` INTEGER NOT NULL DEFAULT 6,
    `updatedAt` DATETIME(6) NOT NULL,

    PRIMARY KEY (`key`, `period`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` CHAR(36) NOT NULL,
    `actorUserId` CHAR(36) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entity` VARCHAR(60) NOT NULL,
    `entityId` CHAR(36) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `audit_log_entity_entityId_idx`(`entity`, `entityId`),
    INDEX `audit_log_actorUserId_idx`(`actorUserId`),
    INDEX `audit_log_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_clients` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `secretHash` CHAR(64) NOT NULL,
    `scopes` VARCHAR(255) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `lastUsedAt` DATETIME(6) NULL,
    `createdAt` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` DATETIME(6) NOT NULL,

    UNIQUE INDEX `api_clients_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `key` VARCHAR(80) NOT NULL,
    `siteId` VARCHAR(36) NOT NULL DEFAULT '',
    `value` JSON NOT NULL,
    `updatedAt` DATETIME(6) NOT NULL,

    PRIMARY KEY (`key`, `siteId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_barcodes` ADD CONSTRAINT `item_barcodes_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `locations` ADD CONSTRAINT `locations_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batches` ADD CONSTRAINT `batches_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serial_units` ADD CONSTRAINT `serial_units_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serial_units` ADD CONSTRAINT `serial_units_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `serial_units` ADD CONSTRAINT `serial_units_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_fromLocationId_fkey` FOREIGN KEY (`fromLocationId`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_toLocationId_fkey` FOREIGN KEY (`toLocationId`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_reasonCodeId_fkey` FOREIGN KEY (`reasonCodeId`) REFERENCES `reason_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movements` ADD CONSTRAINT `movements_countSessionId_fkey` FOREIGN KEY (`countSessionId`) REFERENCES `count_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movement_serials` ADD CONSTRAINT `movement_serials_movementId_fkey` FOREIGN KEY (`movementId`) REFERENCES `movements`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `movement_serials` ADD CONSTRAINT `movement_serials_serialUnitId_fkey` FOREIGN KEY (`serialUnitId`) REFERENCES `serial_units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_levels` ADD CONSTRAINT `stock_levels_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_levels` ADD CONSTRAINT `stock_levels_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_sessions` ADD CONSTRAINT `count_sessions_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_sessions` ADD CONSTRAINT `count_sessions_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_sessions` ADD CONSTRAINT `count_sessions_startedById_fkey` FOREIGN KEY (`startedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_sessions` ADD CONSTRAINT `count_sessions_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_lines` ADD CONSTRAINT `count_lines_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `count_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_lines` ADD CONSTRAINT `count_lines_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_lines` ADD CONSTRAINT `count_lines_batch_fk` FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_tags` ADD CONSTRAINT `count_tags_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `count_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `count_tags` ADD CONSTRAINT `count_tags_serialUnitId_fkey` FOREIGN KEY (`serialUnitId`) REFERENCES `serial_units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sites` ADD CONSTRAINT `user_sites_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sites` ADD CONSTRAINT `user_sites_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `devices` ADD CONSTRAINT `devices_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `devices` ADD CONSTRAINT `devices_assignedUserId_fkey` FOREIGN KEY (`assignedUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `label_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_printerDeviceId_fkey` FOREIGN KEY (`printerDeviceId`) REFERENCES `devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_serialUnitId_fkey` FOREIGN KEY (`serialUnitId`) REFERENCES `serial_units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `print_jobs` ADD CONSTRAINT `print_jobs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `epc_serial_blocks` ADD CONSTRAINT `epc_serial_blocks_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `epc_serial_blocks` ADD CONSTRAINT `epc_serial_blocks_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `devices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
