import 'server-only'
import { randomUUID } from 'node:crypto'
import type { LabelKind } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { ZplError, placeholdersIn, validateZpl } from '@/lib/labels/zpl'
import { requirementsOf } from '@/lib/labels/fields'

/**
 * Editing label templates.
 *
 * Templates live in the database so a label can change without a release
 * (WADR-014). The cost of that is that an administrator can now save something
 * a printer cannot use, so this validates before it stores:
 *
 *  - the ZPL must be a complete document, or the printer stalls waiting for the
 *    rest of a job that never arrives;
 *  - every placeholder must be one the print service can actually fill, or the
 *    template can never print and nobody finds out until somebody tries.
 */

export interface TemplateRow {
  id: string
  name: string
  kind: LabelKind
  zplBody: string
  widthMm: number
  heightMm: number
  dpi: number
  rfidEncode: boolean
  active: boolean
  /** What must be chosen before this template can print. */
  needs: Array<'item' | 'batch' | 'location'>
  usedBy: number
}

export async function listTemplates(db: PrismaClient): Promise<TemplateRow[]> {
  const templates = await db.labelTemplate.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { printJobs: true } } },
  })

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    kind: template.kind,
    zplBody: template.zplBody,
    widthMm: template.widthMm,
    heightMm: template.heightMm,
    dpi: template.dpi,
    rfidEncode: template.rfidEncode,
    active: template.active,
    needs: requirementsOf(placeholdersIn(template.zplBody)).needs,
    usedBy: template._count.printJobs,
  }))
}

export interface TemplateInput {
  name: string
  kind: LabelKind
  zplBody: string
  widthMm: number
  heightMm: number
  dpi: number
  rfidEncode: boolean
}

/**
 * Checks a template before it is stored.
 *
 * Exported so the editor can show the same complaints live, from the same
 * rules, rather than a second opinion that can disagree with the one that
 * actually decides.
 */
export function validateTemplate(input: Pick<TemplateInput, 'zplBody' | 'rfidEncode'>): string[] {
  const problems: string[] = []

  try {
    validateZpl(input.zplBody)
  } catch (error) {
    problems.push(error instanceof ZplError ? error.message : 'That ZPL could not be read.')
  }

  const { unknown } = requirementsOf(placeholdersIn(input.zplBody))
  if (unknown.length > 0) {
    problems.push(
      `Nothing can fill ${unknown.map((name) => `{{${name}}}`).join(', ')}. Use one of the fields listed, or remove it — a template with a field nobody can supply can never print.`,
    )
  }

  // ^RFW is added by the print service, one format per EPC. A template carrying
  // its own would encode the same tag on every label in the run (WADR-009).
  if (/\^RFW/i.test(input.zplBody)) {
    problems.push(
      'Remove the ^RFW command. Tag data is added per label when printing, so a template carrying its own would put the same tag on every label in the run.',
    )
  }

  if (input.rfidEncode && /\^PQ/i.test(input.zplBody)) {
    problems.push(
      'An RFID template cannot use ^PQ. Copies repeat the same tag data; the print service produces one format per tag instead.',
    )
  }

  return problems
}

export async function saveTemplate(
  db: PrismaClient,
  input: TemplateInput,
  templateId?: string,
): Promise<TemplateRow> {
  const problems = validateTemplate(input)
  if (problems.length > 0) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, problems[0]!, { problems })
  }

  const data = {
    name: input.name.trim(),
    kind: input.kind,
    zplBody: input.zplBody,
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    dpi: input.dpi,
    rfidEncode: input.rfidEncode,
  }

  const id = templateId ?? randomUUID()

  try {
    if (templateId) {
      const existing = await db.labelTemplate.findUnique({ where: { id: templateId } })
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'That template does not exist.')
      await db.labelTemplate.update({ where: { id: templateId }, data })
    } else {
      await db.labelTemplate.create({ data: { id, ...data } })
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    // The name is unique, and a duplicate is the likely collision.
    throw new ApiError(
      ErrorCode.CONFLICT,
      'A template with that name already exists. Rename one of them.',
    )
  }

  const [saved] = await listTemplates(db).then((rows) => rows.filter((row) => row.id === id))
  if (!saved) throw new ApiError(ErrorCode.INTERNAL, 'The template could not be read back.')
  return saved
}

/**
 * Retires a template rather than deleting it.
 *
 * Print jobs reference it, and the job record is the only link between a
 * physical RFID tag and the unit it belongs to. Deleting the row would break
 * that for every label ever printed from it.
 */
export async function setTemplateActive(
  db: PrismaClient,
  templateId: string,
  active: boolean,
): Promise<void> {
  const template = await db.labelTemplate.findUnique({ where: { id: templateId } })
  if (!template) throw new ApiError(ErrorCode.NOT_FOUND, 'That template does not exist.')

  await db.labelTemplate.update({ where: { id: templateId }, data: { active } })
}
