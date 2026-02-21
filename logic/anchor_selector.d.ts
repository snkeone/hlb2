export type AnchorRejectReasons = string[];

export interface AnchorSelectResult {
  anchor: any;
  rejectReasons: AnchorRejectReasons;
  candidateDistance: number | null;
}

export function selectAnchor(
  candidates: any[],
  boundary: number | null,
  opts?: { topN?: number; maxDistance?: number }
): AnchorSelectResult;
