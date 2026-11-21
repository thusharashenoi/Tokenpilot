import type { LedgerEntry } from "./types";

const entries: LedgerEntry[] = [];

export function writeLedger(entry: LedgerEntry): void {
  if (!entry.ref) {
    throw new Error("ledger entry needs a ref");
  }
  if (entry.amount < 0) {
    throw new Error("ledger amount cannot be negative");
  }
  entries.push({ ...entry });
}

export function readLedger(): readonly LedgerEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function ledgerTotal(): number {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}
