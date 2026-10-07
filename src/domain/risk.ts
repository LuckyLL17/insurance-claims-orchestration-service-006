import { Participant, RiskSignal, RiskSignalNode } from './types';

export interface RiskNode { key: string; kind: Participant['kind']; claims: Set<string>; }

/** Claim attributes the graph needs; provided lazily by the risk service. */
export interface GraphClaimRef { id: string; participants: Participant[]; lossAt: string; }

export interface GraphLink { node: RiskSignalNode; relatedClaims: string[]; }

export const nodeKey = (kind: Participant['kind'], id: string): string => `${kind}:${id}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deduplicate the participants of one claim on the `kind:id` composite key.
 * Map iteration order follows insertion order, so the first occurrence wins
 * deterministically regardless of how the caller ordered the input.
 */
function dedupeParticipants(participants: Participant[]): Participant[] {
  const unique = new Map<string, Participant>();
  for (const participant of participants) {
    const key = nodeKey(participant.kind, participant.id);
    if (!unique.has(key)) unique.set(key, { ...participant });
  }
  return [...unique.values()];
}

/**
 * Materialized, incremental risk graph: node per participant kind+id, each
 * node holding the current set of claims it participates in. A claim update
 * reconciles the delta so the network converges even when parties are removed,
 * and shared-party signals are only emitted for claims whose loss times fall
 * inside the same sliding time window.
 */
export class RiskGraph {
  private nodes = new Map<string, RiskNode>();
  private claimParticipants = new Map<string, Participant[]>();
  private claimLossAt = new Map<string, string>();

  constructor(private readonly windowDays = 90) {}

  /**
   * Apply the current participant set for a claim and reconcile the graph.
   * Removed parties are detached from the claim and empty nodes are pruned,
   * so stale relationships never survive an update. Returns the deterministic,
   * deduplicated set of signals observed for this claim after reconciliation.
   */
  link(claim: GraphClaimRef): RiskSignal[] {
    const claimId = claim.id;
    const next = dedupeParticipants(claim.participants);
    const previous = this.claimParticipants.get(claimId) ?? [];
    const nextKeys = new Set(next.map((p) => nodeKey(p.kind, p.id)));

    for (const oldParticipant of previous) {
      const key = nodeKey(oldParticipant.kind, oldParticipant.id);
      if (nextKeys.has(key)) continue;
      const node = this.nodes.get(key);
      if (!node) continue;
      // The party was removed from this claim: detach and prune empty nodes.
      node.claims.delete(claimId);
      if (node.claims.size === 0) this.nodes.delete(key);
    }

    for (const participant of next) {
      const key = nodeKey(participant.kind, participant.id);
      const node = this.nodes.get(key) ?? { key, kind: participant.kind, claims: new Set<string>() };
      node.claims.add(claimId);
      this.nodes.set(key, node);
    }

    this.claimParticipants.set(claimId, next);
    if (claim.lossAt) this.claimLossAt.set(claimId, claim.lossAt);
    else this.claimLossAt.delete(claimId);
    return this.signalsFor(claimId);
  }

  /** Drop every edge to a claim (used when a claim is withdrawn). */
  unlink(claimId: string): void {
    for (const participant of this.claimParticipants.get(claimId) ?? []) {
      const key = nodeKey(participant.kind, participant.id);
      const node = this.nodes.get(key);
      if (!node) continue;
      node.claims.delete(claimId);
      if (node.claims.size === 0) this.nodes.delete(key);
    }
    this.claimParticipants.delete(claimId);
    this.claimLossAt.delete(claimId);
  }

  /** Rebuild the graph from claims. Links claims in id order so the result
   *  is independent of ingestion ordering and stays reproducible. */
  rebuild(claims: GraphClaimRef[]): void {
    this.nodes.clear();
    this.claimParticipants.clear();
    this.claimLossAt.clear();
    for (const claim of [...claims].sort((a, b) => a.id.localeCompare(b.id))) this.link(claim);
  }

  /**
   * Current graph signals for one claim. Exactly one signal per shared
   * participant node (same node can never be double counted); related claims
   * are restricted to the same time window and lists are sorted for stable,
   * reproducible output.
   */
  signalsFor(claimId: string): RiskSignal[] {
    const anchorAt = this.claimLossAt.get(claimId);
    const signals: RiskSignal[] = [];
    const participants = this.claimParticipants.get(claimId) ?? [];
    for (const participant of [...participants].sort((a, b) => nodeKey(a.kind, a.id).localeCompare(nodeKey(b.kind, b.id)))) {
      const node = this.nodes.get(nodeKey(participant.kind, participant.id));
      const relatedClaims = [...(node?.claims ?? [])]
        .filter((id) => id !== claimId)
        .filter((id) => !anchorAt || this.withinWindow(anchorAt, this.claimLossAt.get(id)))
        .sort();
      if (relatedClaims.length === 0) continue;
      const score = Math.min(40, relatedClaims.length * 10);
      const trigger: RiskSignalNode = { kind: participant.kind, id: participant.id };
      signals.push({
        code: `SHARED_${participant.kind.toUpperCase()}`,
        score,
        explanation: `${participant.kind} ${participant.id} is shared with ${relatedClaims.length} claim(s) within ${this.windowDays} days`,
        participants: [participant.id, ...relatedClaims],
        node: trigger,
        relatedClaims,
        source: { type: 'graph', rule: `SHARED_${participant.kind.toUpperCase()}`, detail: `claims ${relatedClaims.join(', ')} share ${participant.kind} ${participant.id}` },
      });
    }
    return signals;
  }

  /** Claims connected to the anchor through at least one in-window node. */
  neighborhood(claimId: string): { relatedClaims: string[]; links: GraphLink[] } {
    const related = new Set<string>();
    const links: GraphLink[] = [];
    const anchorAt = this.claimLossAt.get(claimId);
    for (const participant of this.claimParticipants.get(claimId) ?? []) {
      const node = this.nodes.get(nodeKey(participant.kind, participant.id));
      const relatedClaims = [...(node?.claims ?? [])]
        .filter((id) => id !== claimId)
        .filter((id) => !anchorAt || this.withinWindow(anchorAt, this.claimLossAt.get(id)))
        .sort();
      if (relatedClaims.length === 0) continue;
      links.push({ node: { kind: participant.kind, id: participant.id }, relatedClaims });
      for (const id of relatedClaims) related.add(id);
    }
    links.sort((a, b) => nodeKey(a.node.kind, a.node.id).localeCompare(nodeKey(b.node.kind, b.node.id)));
    return { relatedClaims: [...related].sort(), links };
  }

  /** Symmetric sliding window: both loss times must be within windowDays. */
  private withinWindow(a: string, b: string | undefined): boolean {
    if (!b) return true;
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
    return Math.abs(ta - tb) <= this.windowDays * DAY_MS;
  }
}
