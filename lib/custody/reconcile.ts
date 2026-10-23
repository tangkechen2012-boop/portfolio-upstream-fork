export interface CustodyReconciliation {
  bookUnits: number
  observedUnits: string
  delta: number
  matched: boolean
}

export function reconcileCustodyUnits(
  bookUnits: number,
  observedUnits: string,
  tolerance: number,
): CustodyReconciliation {
  const observed = Number(observedUnits)
  if (!Number.isFinite(observed)) throw new Error('Observed units must be a valid number.')
  if (observed < 0) throw new Error('Observed units cannot be negative.')
  if (!Number.isFinite(bookUnits) || bookUnits < 0) throw new Error('Book units must be a non-negative number.')
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Tolerance must be a non-negative number.')
  const delta = Math.round((observed - bookUnits) * 1e12) / 1e12
  return { bookUnits, observedUnits, delta, matched: Math.abs(delta) <= tolerance }
}

