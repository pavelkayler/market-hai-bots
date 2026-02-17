import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Form, Row, Table } from 'react-bootstrap';

import {
  ApiRequestError,
  addUniverseExclusion,
  cancelOrder,
  clearJournal,
  clearUniverse,
  createUniverse,
  deleteProfile,
  downloadExportPack,
  downloadJournal,
  downloadProfiles,
  downloadUniverseJson,
  getBotState,
  getBotStats,
  getJournalTail,
  getProfile,
  getProfiles,
  getReplayFiles,
  getReplayState,
  getUniverse,
  getUniverseExclusions,
  killBot,
  pauseBot,
  refreshUniverse,
  removeUniverseExclusion,
  resetAllRuntimeTables,
  resetBotStats,
  resumeBot,
  saveProfile,
  setActiveProfile,
  startBot,
  startRecording,
  startReplay,
  stopBot,
  stopRecording,
  stopReplay,
  uploadProfiles
} from '../api';
import type { BotPerSymbolStats, BotSettings, BotState, BotStats, EntryReason, JournalEntry, ReplaySpeed, ReplayState, SymbolUpdatePayload, UniverseState } from '../types';
import { useSort } from '../hooks/useSort';
import type { SortState } from '../utils/sort';
import { formatDuration } from '../utils/time';

type LogLine = {
  ts: number;
  text: string;
};

type Props = {
  botState: BotState;
  setBotState: React.Dispatch<React.SetStateAction<BotState>>;
  universeState: UniverseState;
  setUniverseState: React.Dispatch<React.SetStateAction<UniverseState>>;
  symbolMap: Record<string, SymbolUpdatePayload>;
  setSymbolMap: React.Dispatch<React.SetStateAction<Record<string, SymbolUpdatePayload>>>;
  logs: LogLine[];
  syncRest: () => Promise<void>;
  symbolUpdatesPerSecond: number;
};

const SETTINGS_KEY = 'bot.settings.v1';

type PerSymbolRow = BotPerSymbolStats & {
  markPrice: number | null;
  oiCandleValue: number | null;
  oiPrevCandleValue: number | null;
  oiCandleDeltaValue: number | null;
  oiCandleDeltaPct: number | null;
  excluded: boolean;
};

const USE_ACTIVE_PROFILE_ON_START_KEY = 'bot.settings.useActiveProfileOnStart.v1';

type ColumnDef<T> = {
  label: string;
  sortKey: string;
  accessor: (row: T) => unknown;
  align?: 'start' | 'end' | 'center';
};

type SortableHeaderProps<T> = {
  column: ColumnDef<T>;
  sortState: SortState<T>;
  onSort: (key: string) => void;
};

function SortableHeader<T>({ column, sortState, onSort }: SortableHeaderProps<T>) {
  const isActive = sortState?.key === column.sortKey;
  const indicator = isActive ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const className = column.align === 'end' ? 'text-end' : column.align === 'center' ? 'text-center' : undefined;
  return (
    <th role="button" className={className} style={{ cursor: 'pointer' }} onClick={() => onSort(column.sortKey)}>
      {column.label}
      {indicator}
    </th>
  );
}


const EMPTY_BOT_STATS: BotStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winratePct: 0,
  pnlUSDT: 0,
  avgWinUSDT: null,
  avgLossUSDT: null,
  lossStreak: 0,
  todayPnlUSDT: 0,
  guardrailPauseReason: null,
  long: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
  short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
  reasonCounts: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 }
};

const defaultSettings: BotSettings = {
  mode: 'paper',
  direction: 'both',
  tf: 1,
  holdSeconds: 3,
  signalCounterThreshold: 2,
  priceUpThrPct: 0.5,
  oiUpThrPct: 50,
  oiCandleThrPct: 0,
  marginUSDT: 100,
  leverage: 10,
  tpRoiPct: 1,
  slRoiPct: 0.7,
  entryOffsetPct: 0.01,
  maxActiveSymbols: 3,
  dailyLossLimitUSDT: 10,
  maxConsecutiveLosses: 3,
  trendTfMinutes: 5,
  trendLookbackBars: 20,
  trendMinMovePct: 0.2,
  confirmWindowBars: 2,
  confirmMinContinuationPct: 0.1,
  impulseMaxAgeBars: 2,
  requireOiTwoCandles: false,
  maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  minNotionalUSDT: 5
};

function loadSettings(): BotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return defaultSettings;
    }

    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<BotSettings>) };
  } catch {
    return defaultSettings;
  }
}

function loadUseActiveProfileOnStart(): boolean {
  try {
    return localStorage.getItem(USE_ACTIVE_PROFILE_ON_START_KEY) === '1';
  } catch {
    return false;
  }
}

export function BotPage({
  botState,
  setBotState,
  universeState,
  setUniverseState,
  symbolMap,
  setSymbolMap,
  logs,
  syncRest,
  symbolUpdatesPerSecond
}: Props) {
  const [minVolPct, setMinVolPct] = useState<number>(10);
  const [minTurnover, setMinTurnover] = useState<number>(10_000_000);
  const [botStats, setBotStats] = useState<BotStats>(EMPTY_BOT_STATS);
  const [settings, setSettings] = useState<BotSettings>(loadSettings());
  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>('default');
  const [activeProfile, setActiveProfile] = useState<string>('default');
  const [useActiveProfileOnStart, setUseActiveProfileOnStart] = useState<boolean>(loadUseActiveProfileOnStart());
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [showUniverseSymbols, setShowUniverseSymbols] = useState<boolean>(false);
  const [universeSearch, setUniverseSearch] = useState<string>('');
  const [excludedSymbols, setExcludedSymbols] = useState<string[]>([]);
  const [universePage, setUniversePage] = useState<number>(1);
  const [recordTopN, setRecordTopN] = useState<number>(20);
  const [recordFileName, setRecordFileName] = useState<string>(`session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson`);
  const [replayFileName, setReplayFileName] = useState<string>('');
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>('1x');
  const [replayState, setReplayState] = useState<ReplayState>({
    recording: false,
    replaying: false,
    fileName: null,
    speed: null,
    recordsWritten: 0,
    progress: { read: 0, total: 0 }
  });
  const [replayFiles, setReplayFiles] = useState<string[]>([]);
  const [journalLimit, setJournalLimit] = useState<number>(200);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [showPhaseHelp, setShowPhaseHelp] = useState<boolean>(false);
  const [dashboardEntries, setDashboardEntries] = useState<JournalEntry[]>([]);
  const [dashboardFetchedAt, setDashboardFetchedAt] = useState<number | null>(null);
  const profileUploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!botState.lastConfig) {
      return;
    }

    persistSettings(botState.lastConfig);
  }, [botState.lastConfig]);

  const trackedSymbols = useMemo(() => {
    return Object.values(symbolMap)
      .map((item) => {
        if (item.position && item.state !== 'POSITION_OPEN') {
          return { ...item, state: 'POSITION_OPEN' as const };
        }
        if (item.pendingOrder && item.state === 'IDLE') {
          return { ...item, state: 'ENTRY_PENDING' as const };
        }
        return item;
      })
      .filter((item) => item.state !== 'IDLE' || item.pendingOrder || item.position);
  }, [symbolMap]);

  const handleCancelOrder = useCallback(
    (symbol: string) => {
      void cancelOrder(symbol).then(() => syncRest());
    },
    [syncRest]
  );

  const filteredUniverseSymbols = useMemo(() => {
    const symbols = [...(universeState.symbols ?? [])];
    const query = universeSearch.trim().toLowerCase();
    return query.length === 0 ? symbols : symbols.filter((entry) => entry.symbol.toLowerCase().includes(query));
  }, [universeSearch, universeState.symbols]);

  const universeColumns: ColumnDef<(typeof filteredUniverseSymbols)[number]>[] = useMemo(
    () => [
      { label: 'symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'turnover24hUSDT', sortKey: 'turnover24hUSDT', accessor: (row) => row.turnover24hUSDT, align: 'end' },
      { label: 'vol24hRangePct', sortKey: 'vol24hRangePct', accessor: (row) => row.vol24hRangePct, align: 'end' },
      { label: 'high24h', sortKey: 'highPrice24h', accessor: (row) => row.highPrice24h, align: 'end' },
      { label: 'low24h', sortKey: 'lowPrice24h', accessor: (row) => row.lowPrice24h, align: 'end' },
      { label: 'forcedActive', sortKey: 'forcedActive', accessor: (row) => (row.forcedActive ? 1 : 0), align: 'center' }
    ],
    []
  );

  const {
    sortState: universeSortState,
    sortedRows: sortedUniverseSymbols,
    setSortKey: setUniverseSortKey
  } = useSort(filteredUniverseSymbols, { key: 'turnover24hUSDT', dir: 'desc' }, {
    tableId: 'universe-symbols',
    getSortValue: (row, key) => universeColumns.find((column) => column.sortKey === key)?.accessor(row)
  });

  const pageSize = 50;
  const universePageCount = Math.max(1, Math.ceil(sortedUniverseSymbols.length / pageSize));
  const currentUniversePage = Math.min(universePage, universePageCount);
  const paginatedUniverseSymbols = useMemo(() => {
    const start = (currentUniversePage - 1) * pageSize;
    return sortedUniverseSymbols.slice(start, start + pageSize);
  }, [currentUniversePage, sortedUniverseSymbols]);

  useEffect(() => {
    setUniversePage(1);
  }, [sortedUniverseSymbols, universeSearch]);

  useEffect(() => {
    const refreshReplayState = async () => {
      try {
        const [state, filesResponse] = await Promise.all([getReplayState(), getReplayFiles()]);
        setReplayState(state);
        setReplayFiles(filesResponse.files);
      } catch {
        // no-op: optional card state
      }
    };

    void refreshReplayState();
    const interval = window.setInterval(() => {
      void refreshReplayState();
    }, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const persistSettings = (next: BotSettings) => {
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    localStorage.setItem(USE_ACTIVE_PROFILE_ON_START_KEY, useActiveProfileOnStart ? '1' : '0');
  }, [useActiveProfileOnStart]);

  const refreshProfiles = useCallback(async () => {
    const state = await getProfiles();
    setProfileNames(state.names);
    setSelectedProfile((current) => (state.names.includes(current) ? current : state.activeProfile));
    setActiveProfile(state.activeProfile);
  }, []);

  useEffect(() => {
    void refreshProfiles().catch(() => {
      // no-op: profiles are optional for rendering
    });
  }, [refreshProfiles]);

  const refreshBotStats = useCallback(async () => {
    try {
      const response = await getBotStats();
      setBotStats(response.stats);
    } catch {
      // no-op: stats panel remains best-effort
    }
  }, []);


  const refreshExclusions = useCallback(async () => {
    try {
      const response = await getUniverseExclusions();
      setExcludedSymbols(response.excluded);
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    void refreshBotStats();
  }, [refreshBotStats]);

  useEffect(() => {
    void refreshExclusions();
  }, [refreshExclusions]);

  useEffect(() => {
    void refreshBotStats();
  }, [refreshBotStats, botState.activeOrders, botState.openPositions]);

  useEffect(() => {
    if (!botState.running && botState.activeOrders === 0 && botState.openPositions === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshBotStats();
    }, 10000);

    return () => window.clearInterval(interval);
  }, [botState.activeOrders, botState.openPositions, botState.running, refreshBotStats]);

  useEffect(() => {
    if (!universeState.filters) {
      return;
    }

    setMinVolPct(universeState.filters.minVolPct);
    setMinTurnover(universeState.filters.minTurnover);
  }, [universeState.filters]);

  const handleUniverseAction = async (action: 'create' | 'refresh' | 'get' | 'clear') => {
    setError('');
    try {
      if (action === 'create') {
        await createUniverse(minVolPct, minTurnover);
      } else if (action === 'refresh') {
        await refreshUniverse({ minVolPct, minTurnover });
      } else if (action === 'get') {
        const data = await getUniverse();
        setUniverseState(data);
      } else {
        await clearUniverse();
        setUniverseState({ ok: true, ready: false });
        setSymbolMap({});
      }

      await syncRest();
      setStatus(`Universe ${action} ok`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStart = async () => {
    setError('');
    try {
      await startBot(useActiveProfileOnStart ? null : settings);
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleLoadProfile = async (name: string) => {
    setError('');
    try {
      const response = await getProfile(name);
      persistSettings(response.config);
      setSelectedProfile(name);
      setStatus(`Loaded profile: ${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSaveProfile = async (name: string, withConfirm = false) => {
    setError('');
    try {
      if (withConfirm && !window.confirm(`Overwrite profile "${name}"?`)) {
        return;
      }

      await saveProfile(name, settings);
      await refreshProfiles();
      setSelectedProfile(name);
      setStatus(`Saved profile: ${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSaveAsProfile = async () => {
    const name = window.prompt('Save profile as...', selectedProfile === 'default' ? '' : selectedProfile)?.trim();
    if (!name) {
      return;
    }

    const exists = profileNames.includes(name);
    await handleSaveProfile(name, exists);
  };

  const handleSetActiveProfile = async () => {
    setError('');
    try {
      await setActiveProfile(selectedProfile);
      await refreshProfiles();
      setStatus(`Active profile set: ${selectedProfile}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeleteProfile = async () => {
    if (selectedProfile === 'default') {
      alert('default profile cannot be deleted.');
      return;
    }

    if (!window.confirm(`Delete profile "${selectedProfile}"?`)) {
      return;
    }

    setError('');
    try {
      await deleteProfile(selectedProfile);
      await refreshProfiles();
      setStatus(`Deleted profile: ${selectedProfile}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleExportProfiles = async () => {
    setError('');
    try {
      const blob = await downloadProfiles();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'profiles.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('Profiles download started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleImportProfilesFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setError('');
    try {
      const rawText = await file.text();
      await uploadProfiles(JSON.parse(rawText));
      await refreshProfiles();
      setStatus('Profiles imported');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      event.target.value = '';
    }
  };

  const handleStop = async () => {
    setError('');
    try {
      await stopBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot stopped');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePause = async () => {
    setError('');
    try {
      await pauseBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot paused');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleKill = async () => {
    if (!window.confirm('Cancel all pending orders and pause?')) {
      return;
    }

    setError('');
    try {
      const result = await killBot();
      const next = await getBotState();
      setBotState(next);
      await refreshBotStats();
      setStatus(`KILL done: cancelled ${result.cancelled} pending orders`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleResume = async () => {
    setError('');
    try {
      await resumeBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot resumed');
    } catch (err) {
      const apiError = err as ApiRequestError;
      if (apiError.code === 'NO_SNAPSHOT') {
        setError('Snapshot not found. Start a new session or wait for a snapshot to be saved.');
        return;
      }
      setError(apiError.message);
    }
  };

  const handleDownloadUniverseJson = async () => {
    setError('');
    try {
      const blob = await downloadUniverseJson();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'universe.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('Universe download started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopySymbols = async () => {
    const value = (universeState.symbols ?? []).map((entry) => entry.symbol).join('\n');
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Universe symbols copied');
    } catch {
      alert('Clipboard unavailable in this browser/session.');
    }
  };

  const handleRecordStart = async () => {
    setError('');
    try {
      await startRecording(recordTopN, recordFileName);
      setStatus('Recording started');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRecordStop = async () => {
    setError('');
    try {
      await stopRecording();
      setStatus('Recording stopped');
      setReplayState(await getReplayState());
      const files = await getReplayFiles();
      setReplayFiles(files.files);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReplayStart = async () => {
    setError('');
    try {
      await startReplay(replayFileName, replaySpeed);
      setStatus('Replay started');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReplayStop = async () => {
    setError('');
    try {
      await stopReplay();
      setStatus('Replay stopped');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };


  const refreshJournal = async (limit: number = journalLimit) => {
    const response = await getJournalTail(limit);
    setJournalEntries(response.entries);
  };

  const refreshDashboardEvents = useCallback(async () => {
    const response = await getJournalTail(20);
    setDashboardEntries(response.entries);
    setDashboardFetchedAt(Date.now());
  }, []);

  useEffect(() => {
    void refreshJournal();
  }, [journalLimit]);

  useEffect(() => {
    void refreshDashboardEvents();
    if (!botState.running) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshDashboardEvents();
    }, 12000);

    return () => {
      window.clearInterval(interval);
    };
  }, [botState.running, refreshDashboardEvents]);

  const handleClearJournal = async () => {
    if (!window.confirm('Clear journal entries? This cannot be undone.')) {
      return;
    }

    setError('');
    try {
      await clearJournal();
      await refreshJournal();
      setStatus('Journal cleared');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDownloadJournal = async (format: 'ndjson' | 'json' | 'csv') => {
    setError('');
    try {
      const blob = await downloadJournal(format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `journal.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus(`Journal ${format.toUpperCase()} download started`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDownloadExportPack = async () => {
    setError('');
    try {
      const blob = await downloadExportPack();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `export-pack-${new Date().toISOString().replaceAll(':', '-')}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('Export pack download started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleResetStats = async () => {
    if (!window.confirm('Reset bot performance stats?')) {
      return;
    }

    setError('');
    try {
      await resetBotStats();
      await refreshBotStats();
      setStatus('Bot results reset');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleClearAllTables = async () => {
    if (
      !window.confirm(
        'Clear runtime data? This clears runtime symbol state, orders/positions, journal tail, bot stats, universe, exclusions, and replay state. Profiles are kept.'
      )
    ) {
      return;
    }

    setError('');
    try {
      await resetAllRuntimeTables();
      setSymbolMap({});
      setJournalEntries([]);
      setDashboardEntries([]);
      setBotStats(EMPTY_BOT_STATS);
      setExcludedSymbols([]);
      const [nextUniverse, nextReplayState] = await Promise.all([getUniverse(), getReplayState()]);
      setUniverseState(nextUniverse);
      setReplayState(nextReplayState);
      await syncRest();
      setStatus('Runtime tables cleared. Profiles were preserved.');
    } catch (err) {
      const apiError = err as ApiRequestError;
      if (apiError.code === 'BOT_RUNNING') {
        alert('Stop the bot first.');
      } else {
        alert(apiError.message);
      }
      setError(apiError.message);
    }
  };

  const formatPnl = (value: number): string => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const winPct = botStats.totalTrades > 0 ? (botStats.wins / botStats.totalTrades) * 100 : 0;
  const lossPct = botStats.totalTrades > 0 ? (botStats.losses / botStats.totalTrades) * 100 : 0;
  const dashboardLatencyMs = dashboardFetchedAt ? Math.max(0, Date.now() - dashboardFetchedAt) : null;

  const formatJournalSummary = (entry: JournalEntry): string => {
    const qty = typeof entry.data.qty === 'number' ? `qty ${entry.data.qty}` : null;
    const price =
      typeof entry.data.limitPrice === 'number'
        ? `limit ${entry.data.limitPrice}`
        : typeof entry.data.entryPrice === 'number'
          ? `entry ${entry.data.entryPrice}`
          : typeof entry.data.markPrice === 'number'
            ? `mark ${entry.data.markPrice}`
            : null;
    const pnl = typeof entry.data.pnlUSDT === 'number' ? `pnl ${entry.data.pnlUSDT.toFixed(4)}` : null;
    return [qty, price, pnl].filter(Boolean).join(', ') || '-';
  };


  const dashboardTailEntries = useMemo(() => dashboardEntries.slice(-20), [dashboardEntries]);
  const dashboardColumns: ColumnDef<JournalEntry>[] = useMemo(
    () => [
      { label: 'ts', sortKey: 'ts', accessor: (row) => row.ts },
      { label: 'event', sortKey: 'event', accessor: (row) => row.event },
      { label: 'symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'side', sortKey: 'side', accessor: (row) => row.side ?? '' }
    ],
    []
  );
  const { sortState: dashboardSortState, sortedRows: sortedDashboardRows, setSortKey: setDashboardSortKey } = useSort(
    dashboardTailEntries,
    { key: 'ts', dir: 'desc' },
    { tableId: 'dashboard-events', getSortValue: (row, key) => dashboardColumns.find((column) => column.sortKey === key)?.accessor(row) }
  );
  const dashboardEvents = sortedDashboardRows.slice(0, 10);

  const perSymbolRows = useMemo(() => {
    return (botStats.perSymbol ?? []).map((entry) => {
      const live = symbolMap[entry.symbol];
      return {
        ...entry,
        markPrice: live?.markPrice ?? null,
        oiCandleValue: live?.oiCandleValue ?? null,
        oiPrevCandleValue: live?.oiPrevCandleValue ?? null,
        oiCandleDeltaValue: live?.oiCandleDeltaValue ?? null,
        oiCandleDeltaPct: live?.oiCandleDeltaPct ?? null,
        excluded: excludedSymbols.includes(entry.symbol)
      };
    });
  }, [botStats.perSymbol, excludedSymbols, symbolMap]);

  const perSymbolColumns: ColumnDef<PerSymbolRow>[] = useMemo(
    () => [
      { label: 'Symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'Trades', sortKey: 'trades', accessor: (row) => row.trades, align: 'end' },
      { label: 'Wins', sortKey: 'wins', accessor: (row) => row.wins, align: 'end' },
      { label: 'Losses', sortKey: 'losses', accessor: (row) => row.losses, align: 'end' },
      { label: 'Winrate %', sortKey: 'winratePct', accessor: (row) => row.winratePct, align: 'end' },
      { label: 'PnL USDT', sortKey: 'pnlUSDT', accessor: (row) => row.pnlUSDT, align: 'end' },
      { label: 'Long', sortKey: 'longTrades', accessor: (row) => row.longTrades, align: 'end' },
      { label: 'Short', sortKey: 'shortTrades', accessor: (row) => row.shortTrades, align: 'end' },
      { label: 'Price', sortKey: 'markPrice', accessor: (row) => row.markPrice, align: 'end' },
      { label: 'OI candle', sortKey: 'oiCandleValue', accessor: (row) => row.oiCandleValue, align: 'end' },
      { label: 'OI Δ', sortKey: 'oiCandleDeltaValue', accessor: (row) => row.oiCandleDeltaValue, align: 'end' },
      { label: 'OI Δ %', sortKey: 'oiCandleDeltaPct', accessor: (row) => row.oiCandleDeltaPct, align: 'end' },
      { label: 'Last close', sortKey: 'lastClosedTs', accessor: (row) => row.lastClosedTs ?? null, align: 'end' }
    ],
    []
  );
  const { sortState: perSymbolSortState, sortedRows: sortedPerSymbolRows, setSortKey: setPerSymbolSortKey } = useSort(
    perSymbolRows,
    { key: 'pnlUSDT', dir: 'desc' },
    { tableId: 'per-symbol-performance', getSortValue: (row, key) => perSymbolColumns.find((column) => column.sortKey === key)?.accessor(row) }
  );

  const orderRows = useMemo(() => trackedSymbols.filter((item) => item.pendingOrder), [trackedSymbols]);
  const orderColumns: ColumnDef<SymbolUpdatePayload>[] = useMemo(
    () => [
      { label: 'Symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'Side', sortKey: 'side', accessor: (row) => row.pendingOrder?.side ?? '' },
      { label: 'Status', sortKey: 'status', accessor: () => 'ENTRY_PENDING' },
      { label: 'Qty', sortKey: 'qty', accessor: (row) => row.pendingOrder?.qty ?? null, align: 'end' },
      { label: 'Limit', sortKey: 'limitPrice', accessor: (row) => row.pendingOrder?.limitPrice ?? null, align: 'end' },
      { label: 'TP', sortKey: 'tpPrice', accessor: (row) => row.pendingOrder?.tpPrice ?? null, align: 'end' },
      { label: 'SL', sortKey: 'slPrice', accessor: (row) => row.pendingOrder?.slPrice ?? null, align: 'end' },
      { label: 'Placed', sortKey: 'placedTs', accessor: (row) => row.pendingOrder?.placedTs ?? row.pendingOrder?.createdTs ?? null, align: 'end' },
      { label: 'Expires', sortKey: 'expiresTs', accessor: (row) => row.pendingOrder?.expiresTs ?? null, align: 'end' }
    ],
    []
  );
  const { sortState: orderSortState, sortedRows: sortedOrderRows, setSortKey: setOrderSortKey } = useSort(orderRows, { key: 'placedTs', dir: 'desc' }, {
    tableId: 'orders',
    getSortValue: (row, key) => orderColumns.find((column) => column.sortKey === key)?.accessor(row)
  });

  const positionRows = useMemo(() => trackedSymbols.filter((item) => item.position), [trackedSymbols]);
  const noEntryRows = useMemo(() => {
    return Object.values(symbolMap)
      .filter((item) => item.topReasons && item.topReasons.length > 0)
      .slice(0, 20);
  }, [symbolMap]);
  const positionColumns: ColumnDef<SymbolUpdatePayload>[] = useMemo(
    () => [
      { label: 'Symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'Side', sortKey: 'side', accessor: (row) => row.position?.side ?? '' },
      { label: 'Qty', sortKey: 'qty', accessor: (row) => row.position?.qty ?? null, align: 'end' },
      { label: 'Entry', sortKey: 'entryPrice', accessor: (row) => row.position?.entryPrice ?? null, align: 'end' },
      { label: 'TP', sortKey: 'tpPrice', accessor: (row) => row.position?.tpPrice ?? null, align: 'end' },
      { label: 'SL', sortKey: 'slPrice', accessor: (row) => row.position?.slPrice ?? null, align: 'end' },
      { label: 'UnrealizedPnL', sortKey: 'unrealized', accessor: (row) => row.position?.lastPnlUSDT ?? null, align: 'end' },
      { label: 'Open time', sortKey: 'openedTs', accessor: (row) => row.position?.openedTs ?? null, align: 'end' }
    ],
    []
  );
  const { sortState: positionSortState, sortedRows: sortedPositionRows, setSortKey: setPositionSortKey } = useSort(
    positionRows,
    { key: 'openedTs', dir: 'desc' },
    { tableId: 'positions', getSortValue: (row, key) => positionColumns.find((column) => column.sortKey === key)?.accessor(row) }
  );

  const journalColumns: ColumnDef<JournalEntry>[] = useMemo(
    () => [
      { label: 'ts', sortKey: 'ts', accessor: (row) => row.ts },
      { label: 'mode', sortKey: 'mode', accessor: (row) => row.mode },
      { label: 'symbol', sortKey: 'symbol', accessor: (row) => row.symbol },
      { label: 'event', sortKey: 'event', accessor: (row) => row.event },
      { label: 'side', sortKey: 'side', accessor: (row) => row.side ?? '' }
    ],
    []
  );
  const { sortState: journalSortState, sortedRows: sortedJournalEntries, setSortKey: setJournalSortKey } = useSort(
    journalEntries,
    { key: 'ts', dir: 'desc' },
    { tableId: 'journal', getSortValue: (row, key) => journalColumns.find((column) => column.sortKey === key)?.accessor(row) }
  );

  const handleToggleExclude = async (symbol: string, excluded: boolean) => {
    if (botState.running) {
      return;
    }

    setError('');
    try {
      if (excluded) {
        await removeUniverseExclusion(symbol);
      } else {
        await addUniverseExclusion(symbol);
      }
      await Promise.all([syncRest(), refreshExclusions()]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const disableSettings = botState.running;

  const formatEntryReason = (reason: EntryReason | null | undefined): string => {
    if (!reason) {
      return '—';
    }

    return reason
      .split('_')
      .map((part) => `${part[0]}${part.slice(1).toLowerCase()}`)
      .join(' ');
  };

  return (
    <Row className="g-3">
      <Col md={12}>
        <Card>
          <Card.Header>Dashboard</Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col md={3}>
                <div><strong>Trades:</strong> {botStats.totalTrades}</div>
                <div><strong>Winrate:</strong> {botStats.winratePct.toFixed(1)}%</div>
                <div><strong>PnL:</strong> {formatPnl(botStats.pnlUSDT)} USDT</div>
                <div><strong>Today:</strong> {formatPnl(botStats.todayPnlUSDT)} USDT</div>
                <div><strong>Loss streak:</strong> {botStats.lossStreak}</div>
                <div><strong>Guardrail:</strong> {botStats.guardrailPauseReason ?? '-'}</div>
              </Col>
              <Col md={3}>
                <div><strong>Bot:</strong> {botState.running ? (botState.paused ? 'paused' : 'running') : 'stopped'}</div>
                <div><strong>Mode:</strong> {botState.mode ?? '-'}</div>
                <div><strong>TF:</strong> {botState.tf ?? '-'}</div>
                <div><strong>Direction:</strong> {botState.direction ?? '-'}</div>
                <div><strong>Uptime (active):</strong> {formatDuration(botState.uptimeMs)}</div>
              </Col>
              <Col md={3}>
                <div><strong>Queue depth:</strong> {botState.queueDepth}</div>
                <div><strong>Active orders:</strong> {botState.activeOrders}</div>
                <div><strong>Open positions:</strong> {botState.openPositions}</div>
              </Col>
              <Col md={3}>
                <div><strong>Symbol updates/s:</strong> {symbolUpdatesPerSecond.toFixed(2)}</div>
                <div><strong>Journal age:</strong> {dashboardLatencyMs === null ? '-' : `${dashboardLatencyMs}ms`}</div>
                <div><strong>Last event:</strong> {dashboardEntries.length === 0 ? '-' : new Date(dashboardEntries[dashboardEntries.length - 1].ts).toLocaleTimeString()}</div>
              </Col>
            </Row>

            <div className="d-flex flex-wrap gap-2 mt-3">
              <Button variant="outline-primary" onClick={() => void refreshDashboardEvents()}>
                Refresh
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('csv')}>
                Download CSV
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('ndjson')}>
                Download NDJSON
              </Button>
              <Button variant="outline-success" onClick={() => void handleDownloadExportPack()}>
                Download Export Pack
              </Button>
            </div>

            <div className="mt-3">
              <strong>Last events</strong>
              <Table bordered striped size="sm" className="mt-2 mb-0">
                <thead>
                  <tr>
                    {dashboardColumns.map((column) => (
                      <SortableHeader key={column.sortKey} column={column} sortState={dashboardSortState} onSort={setDashboardSortKey} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dashboardEvents.map((entry) => (
                    <tr key={`dash-${entry.ts}-${entry.symbol}-${entry.event}`}>
                      <td>{new Date(entry.ts).toLocaleTimeString()}</td>
                      <td>{entry.event}</td>
                      <td>{entry.symbol}</td>
                      <td>{entry.side ?? '-'}</td>
                    </tr>
                  ))}
                  {dashboardEvents.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center">
                        No recent events
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </div>
          </Card.Body>

        </Card>
      </Col>

      <Col md={6}>
        <Card>
          <Card.Header>Universe</Card.Header>
          <Card.Body>
            <Row className="g-2 mb-3">
              <Col md={6}>
                <Form.Label>minVolPct (%, 24h range)</Form.Label>
                <Form.Control type="number" step={0.01} placeholder="10" value={minVolPct} onChange={(event) => setMinVolPct(Number(event.target.value))} />
                <Form.Text muted>Example: 10 means {'>='} 10% range (high-low)/low over last 24h.</Form.Text>
              </Col>
              <Col md={6}>
                <Form.Label>minTurnover (USDT, 24h)</Form.Label>
                <Form.Control type="number" step={1} placeholder="5000000" value={minTurnover} onChange={(event) => setMinTurnover(Number(event.target.value))} />
                <Form.Text muted>Example: 5,000,000 means {'>='} $5M turnover in last 24h.</Form.Text>
              </Col>
            </Row>
            <div className="d-flex gap-2 flex-wrap mb-3">
              <Button onClick={() => void handleUniverseAction('create')}>Create</Button>
              <Button variant="secondary" onClick={() => void handleUniverseAction('refresh')}>
                Refresh
              </Button>
              <Button variant="outline-primary" onClick={() => void handleUniverseAction('get')}>
                Get
              </Button>
              <Button variant="outline-danger" onClick={() => void handleUniverseAction('clear')}>
                Clear
              </Button>
            </div>
            <div>
              <div>Ready: {String(universeState.ready)}</div>
              <div>Created At: {universeState.createdAt ? new Date(universeState.createdAt).toLocaleString() : '-'}</div>
              <div>
                Filters:{' '}
                {universeState.filters
                  ? `minTurnover ${universeState.filters.minTurnover.toLocaleString()}, minVolPct ${universeState.filters.minVolPct}`
                  : '-'}
              </div>
              <div>Symbols: {universeState.symbols?.length ?? 0}</div>
              <div>Excluded: {excludedSymbols.length}</div>
              <div>Contract filter: USDT Linear Perpetual only</div>
              <div>Vol metric: {universeState.metricDefinition?.volDefinition ?? '24h range % = (high24h-low24h)/low24h*100'}</div>
              <div>Turnover metric: {universeState.metricDefinition?.turnoverDefinition ?? '24h turnover in USDT from Bybit ticker'}</div>
              {typeof universeState.filteredOut?.expiringOrNonPerp === 'number' ? (
                <div>Filtered out (non-perp/expiring): {universeState.filteredOut.expiringOrNonPerp}</div>
              ) : null}
            </div>

            <div className="d-flex gap-2 flex-wrap mt-3">
              <Button variant="outline-primary" onClick={() => setShowUniverseSymbols((value) => !value)}>
                Universe Symbols
              </Button>
              <Button variant="outline-success" onClick={() => void handleDownloadUniverseJson()}>
                Download universe.json
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleCopySymbols()}>
                Copy symbols
              </Button>
            </div>

            <Collapse in={showUniverseSymbols}>
              <div className="mt-3">
                {!universeState.ready ? <Alert variant="warning">Universe is not ready. Create it first.</Alert> : null}
                <Row className="g-2 mb-2">
                  <Col md={12}>
                    <Form.Control
                      placeholder="Search symbol"
                      value={universeSearch}
                      onChange={(event) => setUniverseSearch(event.target.value)}
                    />
                  </Col>
                </Row>
                <Table bordered striped size="sm" className="mb-2">
                  <thead>
                    <tr>
                      {universeColumns.map((column) => (
                        <SortableHeader key={column.sortKey} column={column} sortState={universeSortState} onSort={setUniverseSortKey} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedUniverseSymbols.map((entry) => (
                      <tr key={entry.symbol}>
                        <td>{entry.symbol}</td>
                        <td className="text-end">{entry.turnover24hUSDT.toLocaleString()}</td>
                        <td className="text-end">{entry.vol24hRangePct.toFixed(2)}%</td>
                        <td className="text-end">{entry.highPrice24h.toLocaleString()}</td>
                        <td className="text-end">{entry.lowPrice24h.toLocaleString()}</td>
                        <td className="text-center">{entry.forcedActive ? <Badge bg="warning" text="dark">forced</Badge> : <Badge bg="secondary">no</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="d-flex align-items-center justify-content-between">
                  <small>
                    Page {currentUniversePage}/{universePageCount} ({sortedUniverseSymbols.length} symbols)
                  </small>
                  <div className="d-flex gap-2">
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={currentUniversePage <= 1}
                      onClick={() => setUniversePage((value) => Math.max(1, value - 1))}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={currentUniversePage >= universePageCount}
                      onClick={() => setUniversePage((value) => Math.min(universePageCount, value + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            </Collapse>
          </Card.Body>
        </Card>

        <Card className="mt-3">
          <Card.Header className="d-flex justify-content-between align-items-center">
            <span>Results</span>
            <div className="d-flex gap-2">
              <Button size="sm" variant="outline-secondary" onClick={() => void refreshBotStats()}>
                Refresh
              </Button>
              <Button size="sm" variant="danger" onClick={() => void handleClearAllTables()} disabled={botState.running}>
                Clear all tables
              </Button>
              <Button size="sm" variant="outline-danger" onClick={() => void handleResetStats()}>
                Reset
              </Button>
            </div>
          </Card.Header>
          <Card.Body>
            <div>Total trades: {botStats.totalTrades}</div>
            <div>Wins: {botStats.wins} ({winPct.toFixed(2)}%)</div>
            <div>Losses: {botStats.losses} ({lossPct.toFixed(2)}%)</div>
            <div>Winrate: {botStats.winratePct.toFixed(2)}%</div>
            <div>PnL (USDT): {formatPnl(botStats.pnlUSDT)}</div>
            <div>Today PnL (USDT): {formatPnl(botStats.todayPnlUSDT)}</div>
            <div>Loss streak: {botStats.lossStreak}</div>
            <div>Guardrail pause reason: {botStats.guardrailPauseReason ?? '-'}</div>
            <div>Avg win (USDT): {botStats.avgWinUSDT === null ? '-' : formatPnl(botStats.avgWinUSDT)}</div>
            <div>Avg loss (USDT): {botStats.avgLossUSDT === null ? '-' : formatPnl(botStats.avgLossUSDT)}</div>
            <div>
              Last closed:{' '}
              {botStats.lastClosed ? (
                <span className="font-monospace">
                  {new Date(botStats.lastClosed.ts).toLocaleString()} {botStats.lastClosed.symbol} {botStats.lastClosed.side}{' '}
                  net {formatPnl(botStats.lastClosed.netPnlUSDT)} | fees {formatPnl(botStats.lastClosed.feesUSDT)} ({botStats.lastClosed.reason})
                </span>
              ) : (
                '-'
              )}
            </div>
          </Card.Body>

        </Card>
      </Col>

      <Col md={12}>
        <Card className="mt-3">
          <Card.Header>Per-symbol performance</Card.Header>
          <Card.Body className="table-responsive">
            <Table bordered striped size="sm" className="mb-0">
              <thead>
                <tr>
                  <th>Exclude</th>
                  {perSymbolColumns.map((column) => (
                    <SortableHeader key={column.sortKey} column={column} sortState={perSymbolSortState} onSort={setPerSymbolSortKey} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedPerSymbolRows.map((row) => (
                  <tr key={row.symbol}>
                    <td>
                      <Button
                        size="sm"
                        variant={row.excluded ? 'outline-success' : 'outline-danger'}
                        disabled={botState.running}
                        onClick={() => void handleToggleExclude(row.symbol, row.excluded)}
                      >
                        {row.excluded ? '+' : '-'}
                      </Button>
                    </td>
                    <td>{row.symbol} {row.excluded ? <Badge bg="secondary">excluded</Badge> : null}</td>
                    <td className="text-end">{row.trades}</td>
                    <td className="text-end">{row.wins}</td>
                    <td className="text-end">{row.losses}</td>
                    <td className="text-end">{row.winratePct.toFixed(2)}%</td>
                    <td className="text-end">{formatPnl(row.pnlUSDT)}</td>
                    <td className="text-end">{row.longTrades} ({row.longTrades > 0 ? ((row.longWins / row.longTrades) * 100).toFixed(1) : '0.0'}%)</td>
                    <td className="text-end">{row.shortTrades} ({row.shortTrades > 0 ? ((row.shortWins / row.shortTrades) * 100).toFixed(1) : '0.0'}%)</td>
                    <td className="text-end">{row.markPrice === null ? '-' : `${row.markPrice} (BT)`}</td>
                    <td className="text-end">{row.oiCandleValue === null ? '-' : row.oiCandleValue.toFixed(2)}</td>
                    <td className="text-end">{row.oiCandleDeltaValue === null ? '-' : row.oiCandleDeltaValue.toFixed(2)}</td>
                    <td className="text-end">{row.oiCandleDeltaPct === null ? '-' : `${row.oiCandleDeltaPct.toFixed(2)}%`}</td>
                    <td className="text-end">{row.lastClosedTs ? new Date(row.lastClosedTs).toLocaleTimeString() : '-'}</td>
                  </tr>
                ))}
                {sortedPerSymbolRows.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="text-center">No closed trades yet</td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>

      <Col md={6}>
        <Card>
          <Card.Header>Settings</Card.Header>
          <Card.Body>
            {disableSettings ? <Alert variant="warning">Settings are locked while the bot is running.</Alert> : null}
            <Card className="mb-3">
              <Card.Header>Profiles</Card.Header>
              <Card.Body>
                <Row className="g-2 align-items-end">
                  <Col md={4}>
                    <Form.Label>Profile</Form.Label>
                    <Form.Select value={selectedProfile} onChange={(event) => void handleLoadProfile(event.target.value)}>
                      {profileNames.map((name) => (
                        <option key={name} value={name}>
                          {name}{name === activeProfile ? ' (active)' : ''}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col md={8}>
                    <div className="d-flex flex-wrap gap-2">
                      <Button size="sm" variant="outline-primary" onClick={() => void handleSaveAsProfile()} disabled={disableSettings}>
                        Save As...
                      </Button>
                      <Button size="sm" variant="outline-primary" onClick={() => void handleSaveProfile(selectedProfile, true)} disabled={disableSettings}>
                        Save
                      </Button>
                      <Button size="sm" variant="outline-danger" onClick={() => void handleDeleteProfile()}>
                        Delete
                      </Button>
                      <Button size="sm" variant="outline-success" onClick={() => void handleSetActiveProfile()}>
                        Set Active
                      </Button>
                      <Button size="sm" variant="outline-secondary" onClick={() => void handleExportProfiles()}>
                        Export
                      </Button>
                      <Button size="sm" variant="outline-secondary" onClick={() => profileUploadInputRef.current?.click()}>
                        Import
                      </Button>
                      <input
                        ref={profileUploadInputRef}
                        type="file"
                        accept="application/json,.json"
                        onChange={(event) => void handleImportProfilesFile(event)}
                        style={{ display: 'none' }}
                      />
                    </div>
                  </Col>
                </Row>
              </Card.Body>
            </Card>
            <Row className="g-2">
              <Col>
                <Form.Label>
                  mode <span className="text-muted small">(paper/demo)</span>
                </Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.mode}
                  onChange={(event) => persistSettings({ ...settings, mode: event.target.value as BotSettings['mode'] })}
                >
                  <option value="paper">paper</option>
                  <option value="demo">demo</option>
                </Form.Select>
                <Form.Text muted>paper simulates fills locally; demo sends real demo REST orders.</Form.Text>
              </Col>
              <Col>
                <Form.Label>
                  direction <span className="text-muted small">(long/short/both)</span>
                </Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.direction}
                  onChange={(event) => persistSettings({ ...settings, direction: event.target.value as BotSettings['direction'] })}
                >
                  <option value="long">long</option>
                  <option value="short">short</option>
                  <option value="both">both</option>
                </Form.Select>
                <Form.Text muted>both: engine may take either side (short priority when both fire).</Form.Text>
              </Col>
              <Col>
                <Form.Label>
                  TF <span className="text-muted small">(min)</span>
                </Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.tf}
                  onChange={(event) => persistSettings({ ...settings, tf: Number(event.target.value) as 1 | 3 | 5 })}
                >
                  <option value="1">1</option>
                  <option value="3">3</option>
                  <option value="5">5</option>
                </Form.Select>
                <Form.Text muted>Signal candle size in minutes (UTC boundaries). Example: 1.</Form.Text>
              </Col>
            </Row>
            <Card className="mt-3">
              <Card.Header className="py-2">Signal thresholds</Card.Header>
              <Card.Body>
                <Form.Text muted className="d-block mb-2">Percent convention: 3 means 3% (not 0.03).</Form.Text>
                <Row className="g-2">
                  <Col md={4}>
                    <Form.Label>signalCounterThreshold <span className="text-muted small">(count)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="2" value={settings.signalCounterThreshold} onChange={(event) => persistSettings({ ...settings, signalCounterThreshold: Number(event.target.value) })} />
                    <Form.Text muted>Signals required within rolling 24h. Default: 2.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>priceUpThrPct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="0.5" value={settings.priceUpThrPct} onChange={(event) => persistSettings({ ...settings, priceUpThrPct: Number(event.target.value) })} />
                    <Form.Text muted>Price move threshold vs baseline. 0.5 = 0.5% (not 0.005); SHORT uses symmetric price-down.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>oiUpThrPct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="1" value={settings.oiUpThrPct} onChange={(event) => persistSettings({ ...settings, oiUpThrPct: Number(event.target.value) })} />
                    <Form.Text muted>OI move threshold vs baseline. 1 = 1% (not 0.01); divergence-short also checks OI↑ with price↓.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>oiCandleThrPct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="0.5" value={settings.oiCandleThrPct} onChange={(event) => persistSettings({ ...settings, oiCandleThrPct: Number(event.target.value) })} />
                    <Form.Text muted>Candle-to-candle OI% change vs previous candle. 0.5 = 0.5% (not 0.005); symmetric for long/short.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>maxSecondsIntoCandle <span className="text-muted small">(sec)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="45" value={settings.maxSecondsIntoCandle} onChange={(event) => persistSettings({ ...settings, maxSecondsIntoCandle: Number(event.target.value) })} />
                    <Form.Text muted>Impulse must occur early in the candle. Example: 45 (for TF=1m).</Form.Text>
                  </Col>
                </Row>
              </Card.Body>
            </Card>

            <Card className="mt-3">
              <Card.Header className="py-2">Trend / confirmation</Card.Header>
              <Card.Body>
                <Row className="g-2">
                  <Col md={4}>
                    <Form.Label>trendTfMinutes <span className="text-muted small">(min)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="5" value={settings.trendTfMinutes} onChange={(event) => persistSettings({ ...settings, trendTfMinutes: Number(event.target.value) as 5 | 15 })} />
                    <Form.Text muted>Higher-TF trend source (5 or 15). Example: 5 for 1m fast runs.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>trendLookbackBars <span className="text-muted small">(bars)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="20" value={settings.trendLookbackBars} onChange={(event) => persistSettings({ ...settings, trendLookbackBars: Number(event.target.value) })} />
                    <Form.Text muted>Lookback bars on trend TF. Example: 20 bars.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>trendMinMovePct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="0.15" value={settings.trendMinMovePct} onChange={(event) => persistSettings({ ...settings, trendMinMovePct: Number(event.target.value) })} />
                    <Form.Text muted>Min trend move over lookback. 0.3 means 0.3%.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>confirmMinContinuationPct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="0.1" value={settings.confirmMinContinuationPct} onChange={(event) => persistSettings({ ...settings, confirmMinContinuationPct: Number(event.target.value) })} />
                    <Form.Text muted>Follow-through needed after trigger. 0.1 means 0.1% continuation.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>confirmWindowBars <span className="text-muted small">(bars)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="1" value={settings.confirmWindowBars} onChange={(event) => persistSettings({ ...settings, confirmWindowBars: Number(event.target.value) })} />
                    <Form.Text muted>Bars allowed to find continuation. Example: 2 for safer 1m.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>impulseMaxAgeBars <span className="text-muted small">(bars)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="2" value={settings.impulseMaxAgeBars} onChange={(event) => persistSettings({ ...settings, impulseMaxAgeBars: Number(event.target.value) })} />
                    <Form.Text muted>Reject stale impulses older than this many TF bars.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>requireOiTwoCandles <span className="text-muted small">(bool)</span></Form.Label>
                    <Form.Select disabled={disableSettings} value={settings.requireOiTwoCandles ? 'true' : 'false'} onChange={(event) => persistSettings({ ...settings, requireOiTwoCandles: event.target.value === 'true' })}>
                      <option value="false">false</option>
                      <option value="true">true</option>
                    </Form.Select>
                    <Form.Text muted>Require last 2 OI candle deltas {'>='} oiCandleThrPct. Helps avoid single spikes.</Form.Text>
                  </Col>
                </Row>
              </Card.Body>
            </Card>

            <Card className="mt-3">
              <Card.Header className="py-2">Execution / risk</Card.Header>
              <Card.Body>
                <Row className="g-2">
                  <Col md={4}>
                    <Form.Label>marginUSDT <span className="text-muted small">(USDT)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="100" value={settings.marginUSDT} onChange={(event) => persistSettings({ ...settings, marginUSDT: Number(event.target.value) })} />
                    <Form.Text muted>Margin per trade (collateral). Example: 100.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>leverage <span className="text-muted small">(x)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="10" value={settings.leverage} onChange={(event) => persistSettings({ ...settings, leverage: Number(event.target.value) })} />
                    <Form.Text muted>Notional = margin * leverage. Example: 10.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>tpRoiPct <span className="text-muted small">(% ROI)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="3" value={settings.tpRoiPct} onChange={(event) => persistSettings({ ...settings, tpRoiPct: Number(event.target.value) })} />
                    <Form.Text muted>TP ROI% on margin. 3 means +3% ROI; price move ≈ 3/leverage.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>slRoiPct <span className="text-muted small">(% ROI)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="3" value={settings.slRoiPct} onChange={(event) => persistSettings({ ...settings, slRoiPct: Number(event.target.value) })} />
                    <Form.Text muted>SL ROI% on margin. 3 means -3% ROI; price move ≈ 3/leverage.</Form.Text>
                  </Col>
                  <Col md={8}>
                    <Form.Label>entryOffsetPct <span className="text-muted small">(%)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.01} placeholder="0.01" value={settings.entryOffsetPct} onChange={(event) => persistSettings({ ...settings, entryOffsetPct: Number(event.target.value) })} />
                    <Form.Text muted>LONG entryLimit = mark*(1 - off/100), SHORT entryLimit = mark*(1 + off/100).</Form.Text>
                    <Form.Text muted>Example: 0.01 = 0.01% offset (not 0.0001).</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>minNotionalUSDT <span className="text-muted small">(USDT)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.1} placeholder="5" value={settings.minNotionalUSDT} onChange={(event) => persistSettings({ ...settings, minNotionalUSDT: Number(event.target.value) })} />
                    <Form.Text muted>Gate tiny orders. Example: 5 for paper/demo sanity.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>minSpreadBps <span className="text-muted small">(bps)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={0.1} placeholder="0" value={settings.minSpreadBps} onChange={(event) => persistSettings({ ...settings, minSpreadBps: Number(event.target.value) })} />
                    <Form.Text muted>Optional spread filter. Keep 0 when spread feed is unavailable.</Form.Text>
                  </Col>
                </Row>
              </Card.Body>
            </Card>

            <Card className="mt-3">
              <Card.Header className="py-2">Guardrails</Card.Header>
              <Card.Body>
                <Row className="g-2">
                  <Col md={4}>
                    <Form.Label>maxActiveSymbols <span className="text-muted small">(count)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="3" value={settings.maxActiveSymbols} onChange={(event) => persistSettings({ ...settings, maxActiveSymbols: Number(event.target.value) })} />
                    <Form.Text muted>Max concurrent active symbols (entries/positions). Example: 3.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>dailyLossLimitUSDT <span className="text-muted small">(USDT)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="10" value={settings.dailyLossLimitUSDT} onChange={(event) => persistSettings({ ...settings, dailyLossLimitUSDT: Number(event.target.value) })} />
                    <Form.Text muted>Auto-pause when todayPnL &lt;= -limit. Example: 10.</Form.Text>
                  </Col>
                  <Col md={4}>
                    <Form.Label>maxConsecutiveLosses <span className="text-muted small">(count)</span></Form.Label>
                    <Form.Control disabled={disableSettings} type="number" step={1} placeholder="3" value={settings.maxConsecutiveLosses} onChange={(event) => persistSettings({ ...settings, maxConsecutiveLosses: Number(event.target.value) })} />
                    <Form.Text muted>Auto-pause after N losses in a row. Example: 3.</Form.Text>
                  </Col>
                </Row>
              </Card.Body>
            </Card>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Controls</Card.Header>
          <Card.Body>
            <div className="d-flex gap-2 mb-3">
              <Button variant="success" onClick={() => void handleStart()} disabled={botState.running}>
                Start
              </Button>
              <Button variant="warning" onClick={() => void handlePause()} disabled={!botState.running || botState.paused}>
                Pause
              </Button>
              <Button variant="danger" onClick={() => void handleKill()}>
                KILL
              </Button>
              <Button variant="info" onClick={() => void handleResume()} disabled={!botState.hasSnapshot && !botState.paused}>
                Resume
              </Button>
              <Button variant="danger" onClick={() => void handleStop()} disabled={!botState.running}>
                Stop
              </Button>
            </div>
            <Form.Check
              className="mb-3"
              type="checkbox"
              id="use-active-profile-on-start"
              label="Use active profile on start"
              checked={useActiveProfileOnStart}
              onChange={(event) => setUseActiveProfileOnStart(event.target.checked)}
              disabled={botState.running}
            />
            <Card className="mb-3">
              <Card.Header>Session</Card.Header>
              <Card.Body>
                <div className="mb-2">
                  Snapshot:{' '}
                  <Badge bg={botState.hasSnapshot ? 'success' : 'secondary'}>{botState.hasSnapshot ? 'hasSnapshot=true' : 'none'}</Badge>
                </div>
                {botState.hasSnapshot && !botState.running ? (
                  <Alert variant="info" className="mt-2 mb-0">
                    Snapshot found. Click Resume to continue monitoring/orders.
                  </Alert>
                ) : null}
                {botState.lastConfig ? <div className="mt-2">entryOffsetPct: {botState.lastConfig.entryOffsetPct}%</div> : null}
              </Card.Body>
            </Card>
            <Badge bg="info" className="me-2">
              queueDepth: {botState.queueDepth}
            </Badge>
            <Badge bg="secondary" className="me-2">
              activeOrders: {botState.activeOrders}
            </Badge>
            <Badge bg="dark" className="me-2">openPositions: {botState.openPositions}</Badge>
            <Badge bg="primary" className="me-2">universeSymbols: {universeState.symbols?.length ?? 0}</Badge>
            <Badge bg="light" text="dark">symbolUpdates/s: {symbolUpdatesPerSecond}</Badge>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Replay</Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col md={6}>
                <Card>
                  <Card.Header>Recording</Card.Header>
                  <Card.Body>
                    <Form.Group className="mb-2">
                      <Form.Label>Top N symbols by turnover</Form.Label>
                      <Form.Control type="number" value={recordTopN} onChange={(event) => setRecordTopN(Number(event.target.value))} />
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>File name (.ndjson)</Form.Label>
                      <Form.Control value={recordFileName} onChange={(event) => setRecordFileName(event.target.value)} />
                    </Form.Group>
                    <div className="d-flex gap-2">
                      <Button variant="success" onClick={() => void handleRecordStart()} disabled={replayState.recording || replayState.replaying}>
                        Start recording
                      </Button>
                      <Button variant="danger" onClick={() => void handleRecordStop()} disabled={!replayState.recording}>
                        Stop recording
                      </Button>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
              <Col md={6}>
                <Card>
                  <Card.Header>Replay run</Card.Header>
                  <Card.Body>
                    <Form.Group className="mb-2">
                      <Form.Label>Recorded file</Form.Label>
                      <Form.Select value={replayFileName} onChange={(event) => setReplayFileName(event.target.value)}>
                        <option value="">Select file</option>
                        {replayFiles.map((file) => (
                          <option key={file} value={file}>
                            {file}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>Or type file name</Form.Label>
                      <Form.Control value={replayFileName} onChange={(event) => setReplayFileName(event.target.value)} />
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>Speed</Form.Label>
                      <Form.Select value={replaySpeed} onChange={(event) => setReplaySpeed(event.target.value as ReplaySpeed)}>
                        <option value="1x">1x</option>
                        <option value="5x">5x</option>
                        <option value="20x">20x</option>
                        <option value="fast">fast</option>
                      </Form.Select>
                    </Form.Group>
                    <div className="d-flex gap-2">
                      <Button variant="primary" onClick={() => void handleReplayStart()} disabled={replayState.recording || replayState.replaying || replayFileName.length === 0}>
                        Start replay
                      </Button>
                      <Button variant="outline-danger" onClick={() => void handleReplayStop()} disabled={!replayState.replaying}>
                        Stop replay
                      </Button>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            </Row>
            <div className="mt-3">
              <Badge bg={replayState.recording ? 'success' : 'secondary'} className="me-2">
                recording: {replayState.recording ? 'on' : 'off'}
              </Badge>
              <Badge bg={replayState.replaying ? 'warning' : 'secondary'} className="me-2">
                replaying: {replayState.replaying ? 'on' : 'off'}
              </Badge>
              <Badge bg="info" className="me-2">
                file: {replayState.fileName ?? '-'}
              </Badge>
              <Badge bg="dark" className="me-2">
                speed: {replayState.speed ?? '-'}
              </Badge>
              <Badge bg="primary" className="me-2">
                recordsWritten: {replayState.recordsWritten}
              </Badge>
              <Badge bg="light" text="dark">
                progress: {replayState.progress.read}/{replayState.progress.total}
              </Badge>
            </div>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card className="mb-3">
          <Card.Header className="d-flex justify-content-between align-items-center">
            <span>Phase monitor</span>
            <Button size="sm" variant="link" onClick={() => setShowPhaseHelp((value) => !value)}>
              What does this mean?
            </Button>
          </Card.Header>
          <Card.Body>
            <Collapse in={showPhaseHelp}>
              <div className="mb-3 small text-muted">
                <div><strong>Signal</strong>: HOLDING/ARMED means confirmation is accumulating (no order, no position).</div>
                <div><strong>Order</strong>: ENTRY_PENDING means pending entry exists.</div>
                <div><strong>Position</strong>: POSITION_OPEN means entry filled and TP/SL are active.</div>
              </div>
            </Collapse>
            <Table bordered striped size="sm" className="mb-0">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Phase</th>
                  <th>Reason</th>
                  <th>Signal details</th>
                  <th>Order details</th>
                  <th>Position details</th>
                </tr>
              </thead>
              <tbody>
                {trackedSymbols.map((item) => {
                  const isSignal = item.state === 'HOLDING_LONG' || item.state === 'HOLDING_SHORT' || item.state === 'ARMED_LONG' || item.state === 'ARMED_SHORT';
                  const isOrder = item.state === 'ENTRY_PENDING';
                  const isPosition = item.state === 'POSITION_OPEN';
                  const signalDetails = item.baseline
                    ? `base ${item.baseline.basePrice.toFixed(4)}/${item.baseline.baseOiValue.toFixed(2)} → now ${item.markPrice.toFixed(4)}/${item.openInterestValue.toFixed(2)} | ΔP ${(item.priceDeltaPct ?? 0).toFixed(2)}% ΔOI ${(item.oiDeltaPct ?? 0).toFixed(2)}% OI candle ${item.oiCandleDeltaPct === null || item.oiCandleDeltaPct === undefined ? '—' : `${item.oiCandleDeltaPct.toFixed(2)}%`} | counter ${item.signalCount24h ?? 0}/${item.signalCounterThreshold ?? 0}`
                    : '—';
                  return (
                    <tr key={`phase-${item.symbol}`}>
                      <td>{item.symbol}</td>
                      <td>{item.state}</td>
                      <td>{formatEntryReason(item.entryReason)}</td>
                      <td>{isSignal ? signalDetails : '—'}</td>
                      <td>{isOrder && item.pendingOrder ? `${item.pendingOrder.side} @ ${item.pendingOrder.limitPrice} qty ${item.pendingOrder.qty} exp ${new Date(item.pendingOrder.expiresTs).toLocaleTimeString()} (${item.pendingOrder.sentToExchange ? 'sent' : 'queued'})` : '—'}</td>
                      <td>{isPosition && item.position ? `${item.position.side} entry ${item.position.entryPrice} TP ${item.position.tpPrice} SL ${item.position.slPrice} qty ${item.position.qty}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card.Body>
        </Card>

        <Card className="mb-3">
          <Card.Header>No entry reasons (top)</Card.Header>
          <Card.Body>
            {noEntryRows.length === 0 ? <div className="text-muted">No no-entry reasons yet.</div> : null}
            {noEntryRows.map((row) => (
              <div key={`reasons-${row.symbol}`} className="mb-2">
                <strong>{row.symbol}</strong>: {(row.topReasons ?? []).slice(0, 3).map((reason) => `${reason.code}${typeof reason.value === 'number' ? `=${reason.value.toFixed(3)}` : ''}${typeof reason.threshold === 'number' ? ` (thr ${reason.threshold})` : ''}`).join(', ')}
              </div>
            ))}
          </Card.Body>
        </Card>

        <Card className="mb-3">
          <Card.Header>Top entry reasons (confirmed)</Card.Header>
          <Card.Body>
            <div>Long continuation: {botStats.reasonCounts.LONG_CONTINUATION}</div>
            <div>Short continuation: {botStats.reasonCounts.SHORT_CONTINUATION}</div>
            <div>Short divergence: {botStats.reasonCounts.SHORT_DIVERGENCE}</div>
          </Card.Body>
        </Card>

        <Card>
          <Card.Header>Orders</Card.Header>
          <Card.Body className="table-responsive">
            <Table bordered striped size="sm" className="mb-0">
              <thead>
                <tr>
                  {orderColumns.map((column) => (
                    <SortableHeader key={column.sortKey} column={column} sortState={orderSortState} onSort={setOrderSortKey} />
                  ))}
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedOrderRows.map((item) => (
                  <tr key={`order-${item.symbol}`}>
                    <td>{item.symbol}</td>
                    <td>{item.pendingOrder?.side ?? '-'}</td>
                    <td>{item.pendingOrder?.sentToExchange ? 'sent' : 'queued'}</td>
                    <td className="text-end">{item.pendingOrder?.qty ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.limitPrice ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.tpPrice ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.slPrice ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.placedTs ? new Date(item.pendingOrder.placedTs).toLocaleTimeString() : '-'}</td>
                    <td className="text-end">{item.pendingOrder?.expiresTs ? new Date(item.pendingOrder.expiresTs).toLocaleTimeString() : '-'}</td>
                    <td>
                      <Button size="sm" variant="outline-danger" disabled={!item.pendingOrder} onClick={() => handleCancelOrder(item.symbol)}>
                        Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
                {sortedOrderRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center">No active orders</td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card.Body>
        </Card>

        <Card className="mt-3">
          <Card.Header>Positions</Card.Header>
          <Card.Body className="table-responsive">
            <Table bordered striped size="sm" className="mb-0">
              <thead>
                <tr>
                  {positionColumns.map((column) => (
                    <SortableHeader key={column.sortKey} column={column} sortState={positionSortState} onSort={setPositionSortKey} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedPositionRows.map((item) => (
                  <tr key={`position-${item.symbol}`}>
                    <td>{item.symbol}</td>
                    <td>{item.position?.side ?? '-'}</td>
                    <td className="text-end">{item.position?.qty ?? '-'}</td>
                    <td className="text-end">{item.position?.entryPrice ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.tpPrice ?? '-'}</td>
                    <td className="text-end">{item.pendingOrder?.slPrice ?? '-'}</td>
                    <td className="text-end">{item.position?.lastPnlUSDT === undefined ? '-' : item.position.lastPnlUSDT.toFixed(4)}</td>
                    <td className="text-end">{item.position?.openedTs ? new Date(item.position.openedTs).toLocaleTimeString() : '-'}</td>
                  </tr>
                ))}
                {sortedPositionRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center">No open positions</td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>


      <Col md={12}>
        <Card>
          <Card.Header>Journal</Card.Header>
          <Card.Body>
            <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
              <Form.Group>
                <Form.Label>Limit</Form.Label>
                <Form.Select value={journalLimit} onChange={(event) => setJournalLimit(Number(event.target.value))}>
                  <option value={50}>50</option>
                  <option value={200}>200</option>
                  <option value={1000}>1000</option>
                </Form.Select>
              </Form.Group>
              <Button variant="outline-primary" onClick={() => void refreshJournal()}>
                Refresh
              </Button>
              <Button variant="outline-danger" onClick={() => void handleClearJournal()}>
                Clear
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('ndjson')}>
                NDJSON
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('json')}>
                JSON
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('csv')}>
                CSV
              </Button>
            </div>
            <div className="table-responsive">
              <Table bordered striped size="sm">
                <thead>
                  <tr>
                    {journalColumns.map((column) => (
                      <SortableHeader key={column.sortKey} column={column} sortState={journalSortState} onSort={setJournalSortKey} />
                    ))}
                    <th>summary</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedJournalEntries.map((entry) => (
                    <tr key={`${entry.ts}-${entry.symbol}-${entry.event}-${JSON.stringify(entry.data)}`}>
                      <td>{new Date(entry.ts).toLocaleString()}</td>
                      <td>{entry.mode}</td>
                      <td>{entry.symbol}</td>
                      <td>{entry.event}</td>
                      <td>{entry.side ?? '-'}</td>
                      <td>{formatJournalSummary(entry)}</td>
                    </tr>
                  ))}
                  {sortedJournalEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center">
                        No journal entries
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </div>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Log (last 5)</Card.Header>
          <Card.Body>
            {logs.length === 0 ? <div>No logs yet.</div> : null}
            {logs.map((line) => (
              <div key={`${line.ts}-${line.text}`}>{`${new Date(line.ts).toLocaleTimeString()} - ${line.text}`}</div>
            ))}
          </Card.Body>
        </Card>
      </Col>

      {status ? <Alert variant="success">{status}</Alert> : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}
    </Row>
  );
}
