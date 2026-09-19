-- Warehouse structure and capacity.
--
-- Locations were a flat list whose hierarchy lived entirely in the code string:
-- "A-01" reads as aisle A, rack 01 to a person and as eight characters to the
-- application. Nothing could roll up "how full is aisle A", or offer the racks
-- within a zone, or describe a shelf below a rack.
--
-- parentId makes the structure real and configurable to whatever depth a site
-- needs. ON DELETE RESTRICT because a parent with children must not vanish and
-- leave them pointing at nothing; the service refuses it with a message first.
--
-- capacityUnits is a rough guide, in units, and NULL means nobody has said.
-- Deliberately NOT volume: volume cannot be computed against anything until
-- items carry dimensions, and a capacity nothing can use is a field that looks
-- like a control and is not one.
--
-- Both are nullable and default to NULL, so every existing location keeps
-- working unchanged: a flat warehouse is simply a tree where every location is
-- a root, and an unset capacity warns about nothing.

ALTER TABLE `locations`
  ADD COLUMN `parentId` CHAR(36) NULL,
  ADD COLUMN `capacityUnits` INT NULL;

CREATE INDEX `locations_parentId_idx` ON `locations`(`parentId`);

ALTER TABLE `locations`
  ADD CONSTRAINT `locations_parentId_fkey`
  FOREIGN KEY (`parentId`) REFERENCES `locations`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
