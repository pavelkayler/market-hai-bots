import { useEffect, useMemo, useState } from 'react';

import { compareValues, stableSort, type SortState } from '../utils/sort';

type UseSortOptions<T> = {
  tableId?: string;
  getSortValue?: (row: T, key: keyof T | string) => unknown;
  cycleMode?: 'clear' | 'default';
};

function sameSortState<T>(a: SortState<T>, b: SortState<T>): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.key === b.key && a.dir === b.dir;
}

function loadSortState<T>(tableId?: string): SortState<T> {
  if (!tableId) {
    return null;
  }

  try {
    const raw = localStorage.getItem(`sort:${tableId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as SortState<T>;
    if (!parsed || (parsed.dir !== 'asc' && parsed.dir !== 'desc')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function useSort<T>(rows: T[], defaultSort: SortState<T> = null, options: UseSortOptions<T> = {}) {
  const { tableId, getSortValue, cycleMode = 'default' } = options;
  const [sortState, setSortState] = useState<SortState<T>>(() => loadSortState<T>(tableId) ?? defaultSort);

  useEffect(() => {
    if (!tableId) {
      return;
    }

    if (!sortState) {
      localStorage.removeItem(`sort:${tableId}`);
      return;
    }

    localStorage.setItem(`sort:${tableId}`, JSON.stringify(sortState));
  }, [sortState, tableId]);

  const sortedRows = useMemo(() => {
    if (!sortState) {
      return rows;
    }

    return stableSort(rows, (a, b) => {
      const av = getSortValue ? getSortValue(a, sortState.key) : (a as Record<string, unknown>)[String(sortState.key)];
      const bv = getSortValue ? getSortValue(b, sortState.key) : (b as Record<string, unknown>)[String(sortState.key)];
      return compareValues(av, bv, sortState.dir);
    });
  }, [getSortValue, rows, sortState]);

  const clearSort = () => setSortState(null);

  const setSortKey = (key: keyof T | string) => {
    setSortState((prev) => {
      const isDefault = sameSortState(prev, defaultSort);

      if (!prev || prev.key !== key) {
        return { key, dir: 'asc' };
      }

      if (isDefault) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      }

      if (prev.dir === 'asc') {
        return { key, dir: 'desc' };
      }

      return cycleMode === 'clear' ? null : defaultSort;
    });
  };

  return {
    sortState,
    sortedRows,
    setSortKey,
    clearSort
  };
}
