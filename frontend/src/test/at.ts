/**
 * The item at `index` (negative counts from the end), failing the test with a
 * clear message when it is missing. An index read is `T | undefined` under
 * `noUncheckedIndexedAccess`; a test that expects the item should fail loudly
 * at the read, not carry the `undefined` into a confusing later error.
 */
export function at<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index < 0 ? items.length + index : index]
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index}, but there are ${items.length}`)
  }
  return item
}
