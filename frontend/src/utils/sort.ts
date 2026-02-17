export type SortDir = 'asc' | 'desc';

export type SortState<T> = { key: keyof T | string; dir: SortDir } | null;

function isNilLike(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === '-';
}

export function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  if (isNilLike(a) && isNilLike(b)) {
    return 0;
  }
  if (isNilLike(a)) {
    return 1;
  }
  if (isNilLike(b)) {
    return -1;
  }

  const sign = dir === 'asc' ? 1 : -1;

  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return (a - b) * sign;
  }

  const aStr = String(a);
  const bStr = String(b);
  return aStr.localeCompare(bStr, undefined, { sensitivity: 'base', numeric: true }) * sign;
}

export function stableSort<T>(rows: T[], comparator: (a: T, b: T) => number): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const compared = comparator(a.row, b.row);
      if (compared !== 0) {
        return compared;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}
