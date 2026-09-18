/**
 * The fields a label template may reference.
 *
 * One list, used three ways: the print service fills them, the template editor
 * validates against them, and the editor's preview substitutes sample values.
 * Keeping it in one place is what stops an administrator saving a template
 * referencing `{{itemname}}` and only discovering at the printer that it can
 * never be filled.
 *
 * Pure and free of server-only imports, so the editor can use it directly.
 */

export interface LabelFieldDescriptor {
  name: string
  /** What it is, in the words of somebody writing a label. */
  describes: string
  /** Where it comes from, so the editor can say what a template will need. */
  needs: 'item' | 'batch' | 'location' | 'always'
  /** A realistic value, for the preview. */
  sample: string
}

export const LABEL_FIELDS: readonly LabelFieldDescriptor[] = [
  { name: 'itemName', describes: 'Item name', needs: 'item', sample: 'Cordless drill 18 V' },
  { name: 'sku', describes: 'Item code', needs: 'item', sample: 'TLS-0021' },
  { name: 'unit', describes: 'Unit of measure', needs: 'item', sample: 'pcs' },
  {
    name: 'barcode',
    describes: 'Full EAN-13, including its check digit',
    needs: 'item',
    sample: '8901234000212',
  },
  {
    name: 'barcode12',
    // ^BE makes the printer compute the check digit, so it is given twelve.
    describes: 'First 12 digits, for a ^BE barcode the printer completes',
    needs: 'item',
    sample: '890123400021',
  },
  { name: 'batchNo', describes: 'Batch number', needs: 'batch', sample: 'LOT-0042' },
  { name: 'expiryDate', describes: 'Expiry date', needs: 'batch', sample: '2027-03-31' },
  { name: 'mfgDate', describes: 'Manufacture date', needs: 'batch', sample: '2026-03-31' },
  { name: 'location', describes: 'Location code', needs: 'location', sample: 'A-01' },
  { name: 'code', describes: 'Location code, for a bin label', needs: 'location', sample: 'A-01' },
  { name: 'locationName', describes: 'Location name', needs: 'location', sample: 'Aisle A · Rack 01' },
  { name: 'printedOn', describes: "Today's date", needs: 'always', sample: '2026-09-18' },
] as const

const BY_NAME = new Map(LABEL_FIELDS.map((field) => [field.name, field]))

export function isLabelField(name: string): boolean {
  return BY_NAME.has(name)
}

export function labelField(name: string): LabelFieldDescriptor | undefined {
  return BY_NAME.get(name)
}

/** Sample values for every field, so a template can be previewed before use. */
export function sampleFields(): Record<string, string> {
  return Object.fromEntries(LABEL_FIELDS.map((field) => [field.name, field.sample]))
}

/**
 * What a template needs before it can print.
 *
 * An administrator writing a batch label should be told it will need a batch,
 * rather than finding out when an operator cannot print it.
 */
export function requirementsOf(placeholders: readonly string[]): {
  needs: Array<'item' | 'batch' | 'location'>
  unknown: string[]
} {
  const needs = new Set<'item' | 'batch' | 'location'>()
  const unknown: string[] = []

  for (const placeholder of placeholders) {
    const field = BY_NAME.get(placeholder)
    if (!field) {
      unknown.push(placeholder)
      continue
    }
    if (field.needs !== 'always') needs.add(field.needs)
  }

  return { needs: [...needs], unknown }
}
