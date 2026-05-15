// v2.9.0+ Reciprocal Rank Fusion (RRF) for hybrid retrieval (NEW —
// reviewer's preferred fusion pattern over the prior weighted-linear scorer).
//
// RRF (Cormack, Clarke, Buettcher 2009) treats each retriever as producing
// a RANKED LIST and fuses by:
//
//     score(doc) = Σ over lists  1 / (k + rank_in_list)
//
// k is a small constant (60 is the well-tested default). Documents that
// rank high in MULTIPLE lists rise to the top, while documents that rank
// high in only one list are dampened. The key advantage over weighted-
// linear fusion: RRF is *scale-free* — it doesn't matter that keyword
// scores are in [0, 5] while vector cosines are in [0, 1] while graph
// support is a count. You only need ranks.
//
// We expose RRF as an opt-in fusion strategy alongside the existing
// weighted-linear scorer. Callers set `query.fusion = "rrf"` to switch.
// The weighted-linear path stays the default for now because it has been
// in production since v2.5.1 and we want a back-to-back benchmark
// (LongMemEval) to determine the lift before flipping the default.

export interface RankedList<T extends { id: string }> {
  name: string;
  items: T[];  // already sorted best-first
}

export interface RRFResult<T extends { id: string }> {
  id: string;
  rrf_score: number;
  contributions: Record<string, number>;  // per-list 1/(k+rank), 0 if absent
  hit: T | null;                          // payload of the first list that contained this id
}

export function reciprocalRankFusion<T extends { id: string }>(
  lists: RankedList<T>[],
  k = 60,
): RRFResult<T>[] {
  const acc = new Map<string, RRFResult<T>>();
  for (const list of lists) {
    list.items.forEach((item, idx) => {
      const rank = idx + 1;
      const contrib = 1 / (k + rank);
      const existing = acc.get(item.id);
      if (existing) {
        existing.rrf_score += contrib;
        existing.contributions[list.name] = contrib;
      } else {
        const initialContribs: Record<string, number> = {};
        for (const l of lists) initialContribs[l.name] = 0;
        initialContribs[list.name] = contrib;
        acc.set(item.id, {
          id: item.id,
          rrf_score: contrib,
          contributions: initialContribs,
          hit: item,
        });
      }
    });
  }
  return [...acc.values()].sort((a, b) => b.rrf_score - a.rrf_score);
}
