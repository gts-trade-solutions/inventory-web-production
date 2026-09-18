'use client'

import { previewZpl, type BarcodeElement, type LabelPreview } from '@/lib/labels/preview'
import { Badge } from '@/components/ui/badge'

/**
 * Draws the label from the ZPL that will be sent.
 *
 * Parsed from the same bytes the printer gets, so this is a rendering of the
 * job rather than a picture of what we hope the job says. Anything it cannot
 * draw is named on screen, because an operator approving a layout should know
 * the preview is incomplete rather than assume it is complete.
 */
export function LabelPreviewer({ zpl }: { zpl: string }) {
  const labels = previewZpl(zpl)

  if (labels.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
  }

  return (
    <div className="space-y-4">
      {labels.slice(0, 3).map((label, index) => (
        <LabelFace key={index} label={label} />
      ))}

      {labels.length > 3 && (
        <p className="text-sm text-muted-foreground">
          …and {labels.length - 3} more label{labels.length - 3 === 1 ? '' : 's'} in this job.
        </p>
      )}
    </div>
  )
}

function LabelFace({ label }: { label: LabelPreview }) {
  // Falls back to a 4×2 inch label at 203 dpi when the ZPL does not say, which
  // is the commonest stock.
  const width = label.widthDots ?? 812
  const height = label.heightDots ?? 406

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border bg-white p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          role="img"
          aria-label="Label preview"
        >
          <rect x={0} y={0} width={width} height={height} fill="#ffffff" />

          {label.elements.map((element, index) =>
            element.kind === 'TEXT' ? (
              <text
                key={index}
                x={element.x}
                // ZPL positions text by its TOP edge; SVG by its baseline.
                y={element.y + element.height * 0.82}
                fontSize={element.height}
                fontFamily="Helvetica, Arial, sans-serif"
                fill="#000000"
              >
                {truncate(element.text, element.blockWidth, element.height)}
              </text>
            ) : (
              <Barcode key={index} element={element} />
            ),
          )}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular">
          {width} × {height} dots
        </span>
        {label.copies > 1 && <Badge variant="secondary">{label.copies} copies</Badge>}
        {label.epc && (
          <Badge variant="outline">
            Encodes tag <span className="tabular ml-1">{label.epc}</span>
          </Badge>
        )}
        {label.unsupported.length > 0 && (
          <Badge variant="warn">
            Not drawn: {[...new Set(label.unsupported)].join(' ')}
          </Badge>
        )}
      </div>

      {label.elements.some((element) => element.kind === 'BARCODE' && element.note) && (
        <p className="text-xs text-muted-foreground">
          {label.elements
            .filter((element): element is BarcodeElement => element.kind === 'BARCODE')
            .map((element) => element.note)
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
    </div>
  )
}

function Barcode({ element }: { element: BarcodeElement }) {
  const textHeight = 26

  if (!element.bars) {
    // Drawn as an outline rather than as fake bars. A convincing-looking
    // barcode that encodes nothing is worse than an obvious placeholder.
    const width = Math.max(element.data.length * element.moduleWidth * 11, 120)
    return (
      <g>
        <rect
          x={element.x}
          y={element.y}
          width={width}
          height={element.height}
          fill="none"
          stroke="#9ca3af"
          strokeDasharray="6 4"
        />
        <text
          x={element.x + 8}
          y={element.y + element.height / 2}
          fontSize={22}
          fontFamily="Helvetica, Arial, sans-serif"
          fill="#6b7280"
        >
          {element.symbology} · {element.data}
        </text>
      </g>
    )
  }

  const barWidth = element.moduleWidth
  // Guard bars run below the digits, which is how an EAN-13 actually looks.
  const isGuard = (index: number) =>
    index < 3 || (index >= 45 && index < 50) || index >= 92

  return (
    <g>
      {element.bars.split('').map((bit, index) =>
        bit === '1' ? (
          <rect
            key={index}
            x={element.x + index * barWidth}
            y={element.y}
            width={barWidth}
            height={
              element.showText && !isGuard(index) ? element.height : element.height + textHeight * 0.5
            }
            fill="#000000"
          />
        ) : null,
      )}

      {element.showText && element.groups && (
        <>
          <text
            x={element.x - barWidth * 3}
            y={element.y + element.height + textHeight}
            fontSize={textHeight}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="#000000"
            textAnchor="end"
          >
            {element.groups[0]}
          </text>
          <text
            x={element.x + barWidth * 24}
            y={element.y + element.height + textHeight}
            fontSize={textHeight}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="#000000"
            textAnchor="middle"
          >
            {element.groups[1]}
          </text>
          <text
            x={element.x + barWidth * 71}
            y={element.y + element.height + textHeight}
            fontSize={textHeight}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="#000000"
            textAnchor="middle"
          >
            {element.groups[2]}
          </text>
        </>
      )}
    </g>
  )
}

/**
 * Approximates ^FB wrapping by clipping.
 *
 * Honest about being an approximation: the printer wraps by its own font
 * metrics, which the browser does not have. Long text is more likely to be
 * clipped here than there, which errs towards the operator noticing.
 */
function truncate(text: string, blockWidth: number | undefined, fontHeight: number): string {
  if (!blockWidth) return text

  const approximateCharWidth = fontHeight * 0.55
  const maximum = Math.floor(blockWidth / approximateCharWidth)
  return text.length > maximum ? `${text.slice(0, Math.max(maximum - 1, 1))}…` : text
}
