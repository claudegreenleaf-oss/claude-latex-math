import type { Register } from 'claude-code'

type TSize = { width: number; height: number }
type TFormula = { png: string; size: TSize } | null
type TSegment = { kind: 'text'; text: string } | { kind: 'math'; tex: string; source: string }

const SCALE = 2
const DPI = String(180 * SCALE)
const FOREGROUND = 'rgb 0.85 0.85 0.85'
const MARGIN = 4
const CELL_WIDTH = 9
const CELL_HEIGHT = 19
const CACHE_LIMIT = 200
const RENDER_TIMEOUT_MS = 15_000

const SCRIPT = [
  'set -e',
  'd=$(mktemp -d)',
  'trap \'rm -rf "$d"\' EXIT',
  'cd "$d"',
  'cat > f.tex',
  'latex -interaction=nonstopmode -halt-on-error f.tex >/dev/null 2>&1',
  `dvipng -q -T tight -D ${DPI} -bg Transparent -fg '${FOREGROUND}' -o f.png f.dvi >/dev/null 2>&1`,
  "base64 < f.png | tr -d '\\n'",
].join('\n')

const PROMPT = `# Math in the terminal

This terminal typesets display math. A formula between \`$$\` and \`$$\` (or \`\\[\` and \`\\]\`), as a paragraph of its own, is compiled with LaTeX and drawn as an image in your reply. Use it whenever a formula reads better typeset: fractions, sums, integrals, matrices, derivations, any equation worth a second look.

- Inline \`$...$\` is not typeset: the person sees the raw source. Inside a sentence, write light math in plain Unicode (x², α + β ≤ 1, √2, xᵢ) and move anything heavier to its own display paragraph.
- Each formula is compiled alone inside \`\\[...\\]\` with only amsmath and amssymb loaded. For several lines use \`aligned\`, \`gathered\` or \`cases\`, never \`align\`, \`equation\` or \`$\`. No \`\\newcommand\`, \`\\label\`, \`\\bm\` or other packages' commands; \`\\mathbb\`, \`\\mathcal\`, \`\\operatorname\`, \`\\text\`, \`\\boxed\` and the matrix environments are fine.
- Split a long formula with \`aligned\` rather than letting it shrink to fit the terminal width.
- Math in code spans, code blocks, tables and headings stays raw text. Keep display math out of them and out of list items: put it between paragraphs.
- A formula LaTeX rejects is shown as its source.`

const formulas = new Map<string, TFormula>()
const pending = new Map<string, Promise<TFormula>>()

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string) => {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0

  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

const pngSize = (base64: string): TSize | null => {
  const header = decodeBase64(base64.slice(0, 44))
  const isSignature = header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  if (!isSignature) return null

  const view = new DataView(header.buffer)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const document = (tex: string) =>
  [
    '\\documentclass{article}',
    '\\usepackage{amsmath,amssymb}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    `\\[${tex}\\]`,
    '\\end{document}',
  ].join('\n')

const remember = (tex: string, formula: TFormula) => {
  formulas.set(tex, formula)
  if (formulas.size > CACHE_LIMIT) {
    const oldest = formulas.keys().next().value
    if (oldest !== undefined) formulas.delete(oldest)
  }
}

const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g
const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g

const pushText = (segments: TSegment[], text: string) => {
  if (text.length === 0) return
  const last = segments[segments.length - 1]
  if (last?.kind === 'text') last.text += text
  else segments.push({ kind: 'text', text })
}

const split = (text: string): TSegment[] => {
  const segments: TSegment[] = []

  for (const [index, part] of text.split(FENCE).entries()) {
    if (index % 2 === 1) {
      pushText(segments, part)
      continue
    }

    let cursor = 0
    for (const match of part.matchAll(MATH)) {
      const tex = (match[1] ?? match[2] ?? '').trim()
      if (tex.length === 0) continue
      pushText(segments, part.slice(cursor, match.index))
      segments.push({ kind: 'math', tex, source: match[0] })
      cursor = (match.index ?? 0) + match[0].length
    }
    pushText(segments, part.slice(cursor))
  }

  return segments
}

const boxFor = ({ width, height }: TSize, maxColumns: number) => {
  const ratio = (width * CELL_HEIGHT) / (height * CELL_WIDTH)
  let rows = Math.max(1, Math.round(height / CELL_HEIGHT))
  let columns = Math.max(1, Math.round(rows * ratio))

  if (columns > maxColumns) {
    columns = maxColumns
    rows = Math.max(1, Math.round(columns / ratio))
  }

  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

export const register: Register = on => {
  let hasLatex: Promise<boolean> | null = null

  const render = async (run: (argv: readonly string[], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string }>, tex: string) => {
    const cached = formulas.get(tex)
    if (cached !== undefined) return cached

    const inFlight = pending.get(tex)
    if (inFlight) return inFlight

    const job = (async (): Promise<TFormula> => {
      try {
        const { exitCode, stdout } = await run(['sh', '-c', SCRIPT], {
          stdin: document(tex),
          timeoutMs: RENDER_TIMEOUT_MS,
        })
        const png = stdout.trim()
        const size = exitCode === 0 && png ? pngSize(png) : null
        return size ? { png, size } : null
      } catch {
        return null
      }
    })()

    pending.set(tex, job)
    const formula = await job
    pending.delete(tex)
    remember(tex, formula)
    return formula
  }

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!e.surfaces.includes('terminal') || e.traits.includes('print')) return result

    hasLatex ??= $.process
      .run(['sh', '-c', 'command -v latex && command -v dvipng'], { timeoutMs: RENDER_TIMEOUT_MS })
      .then(({ exitCode }) => exitCode === 0)
      .catch(() => false)
    if (!(await hasLatex)) return result

    return { sections: [...result.sections, { id: 'latex-math:math', text: PROMPT, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)

    const segments = split(e.props.text)
    if (!segments.some(segment => segment.kind === 'math')) return next(e)

    const run = (argv: readonly string[], init: { stdin: string; timeoutMs: number }) =>
      $.process.run(argv, init)

    const drawn = await Promise.all(
      segments.map(segment => (segment.kind === 'math' ? render(run, segment.tex) : Promise.resolve(null))),
    )
    if (drawn.every(formula => formula === null)) return next(e)

    const viewportColumns = e.viewport?.columns ?? 80
    const maxColumns = Math.max(10, viewportColumns - MARGIN)
    const { Box, Image } = $.ui.resolve(e)

    // Text, and a formula LaTeX rejected, go down the chain one piece at a
    // time, so the engine and the plugins beneath (diagrams, links) draw it
    // as they would a reply of its own, and never see a formula drawn here.
    const blocks = []
    for (const [index, segment] of segments.entries()) {
      const formula = drawn[index] ?? null

      if (segment.kind === 'math' && formula) {
        const box = boxFor(
          { width: formula.size.width / SCALE, height: formula.size.height / SCALE },
          maxColumns,
        )
        blocks.push(
          <Box key={`m${index}`} marginLeft={2}>
            <Image
              source={{ png: formula.png }}
              columns={box.columns}
              rows={box.rows}
              alt={segment.source.replace(/\s+/g, ' ')}
            />
          </Box>,
        )
        continue
      }

      const text = segment.kind === 'math' ? segment.source : segment.text.trim()
      if (!text) continue
      const isFirstOfReply = index === 0 ? e.props.isFirstOfReply : false
      blocks.push(<Box key={`t${index}`}>{await next({ ...e, props: { ...e.props, text, isFirstOfReply } })}</Box>)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {blocks}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
