import raw from '../generated/stats.json';

export interface BenchRow {
  case: string;
  unit: string;
  opus: { ms: number; perSec: number };
  sqlite: { ms: number; perSec: number };
  ratio: number;
}
export interface BenchFile {
  rows: number;
  file: boolean;
  node: string;
  sqlite: string;
  results: BenchRow[];
}
export interface FuzzSummary {
  seeds: number;
  queries: number;
  compared: number;
  agreed: number;
  bothErrored: number;
  mismatches: number;
  sqliteInconsistencies?: number;
  agreement: number;
  rowsCompared: number;
  seconds: number;
  features: Record<string, number>;
}
export interface RepoStats {
  generatedAt: string;
  loc: {
    engine: number;
    engineTests: number;
    server: number;
    serverTests: number;
    studio: number;
    subsystems: { name: string; lines: number; files: number }[];
  };
  tests: { engine: number; server: number };
  runtimeDependencies: { engine: number; server: number };
  benchMemory: BenchFile | null;
  benchFile: BenchFile | null;
  fuzz: FuzzSummary | null;
}

export const STATS = raw as unknown as RepoStats;
