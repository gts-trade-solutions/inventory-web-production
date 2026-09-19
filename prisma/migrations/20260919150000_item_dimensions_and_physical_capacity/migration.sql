-- Item dimensions, and physical capacity on a location.
--
-- Capacity so far has been in UNITS, which is a rough guide and honest about
-- it. These columns are what a real fit calculation needs: how big and heavy
-- one unit of an item is, and how much a place can physically take.
--
-- Every column is nullable, and nullable is the normal state. Measuring every
-- SKU is ongoing warehouse work, not a data-entry afterthought, and a system
-- that computes fit from guessed dimensions sends people to bays the goods do
-- not fit in. Anything derived from these reports UNKNOWN when they are
-- missing, and reports how much of a location's stock it could account for
-- rather than quietly undercounting.
--
-- Millimetres and grams as integers: no floating-point drift accumulating
-- across a bay of ten thousand units. Volume is derived from the three
-- dimensions in code and never stored, so the two can never disagree.

ALTER TABLE `items`
  ADD COLUMN `weightGrams` INT NULL,
  ADD COLUMN `lengthMm` INT NULL,
  ADD COLUMN `widthMm` INT NULL,
  ADD COLUMN `heightMm` INT NULL;

ALTER TABLE `locations`
  ADD COLUMN `capacityVolumeCm3` INT NULL,
  ADD COLUMN `capacityWeightGrams` INT NULL;
