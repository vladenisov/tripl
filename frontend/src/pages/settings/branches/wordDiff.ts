/**
 * Word-level diff for the before → after of a long string field (PLAN-19).
 *
 * A description edit arrives as two whole paragraphs, and finding the one word
 * that changed meant comparing them by eye. This marks the words each side
 * does not share with the other — a plain LCS over whitespace-split tokens,
 * which is plenty for the prose these fields hold.
 */

export interface WordSegment {
  text: string
  /** Not in the other side: removed on the before side, added on the after. */
  changed: boolean
}

/** Below this, the two values are short enough to compare at a glance. */
export const WORD_DIFF_MIN_LENGTH = 40

/** The LCS table is tokens × tokens; past this the highlight is not worth it. */
const MAX_CELLS = 250_000

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== '')
}

function pushSegment(segments: WordSegment[], text: string, changed: boolean) {
  const last = segments[segments.length - 1]
  if (last && last.changed === changed) {
    segments[segments.length - 1] = { text: last.text + text, changed }
  } else {
    segments.push({ text, changed })
  }
}

/**
 * The two sides split into shared and changed runs, or null when a highlight
 * would not help: either value is short, the table would be too large, or the
 * two share no word at all (everything would be marked).
 */
export function wordDiff(
  before: string,
  after: string,
): { before: WordSegment[]; after: WordSegment[] } | null {
  if (Math.max(before.length, after.length) < WORD_DIFF_MIN_LENGTH) return null
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length * b.length > MAX_CELLS) return null

  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  // Whitespace always matches something; only shared WORDS make it readable.
  const sharedWords = (() => {
    let i = 0
    let j = 0
    let words = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        if (a[i].trim() !== '') words += 1
        i += 1
        j += 1
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        i += 1
      } else {
        j += 1
      }
    }
    return words
  })()
  if (sharedWords === 0) return null

  const beforeSegments: WordSegment[] = []
  const afterSegments: WordSegment[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushSegment(beforeSegments, a[i], false)
      pushSegment(afterSegments, b[j], false)
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pushSegment(beforeSegments, a[i], true)
      i += 1
    } else {
      pushSegment(afterSegments, b[j], true)
      j += 1
    }
  }
  for (; i < a.length; i += 1) pushSegment(beforeSegments, a[i], true)
  for (; j < b.length; j += 1) pushSegment(afterSegments, b[j], true)
  return { before: beforeSegments, after: afterSegments }
}
