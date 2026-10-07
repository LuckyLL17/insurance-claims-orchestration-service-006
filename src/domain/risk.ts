import { Participant, RiskSignal, RiskSignalSource, TriggeredRiskNode } from './types';

export const DEFAULT_RISK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface RiskNode { key: string; kind: Participant['kind']; claims: Set<string>; }
export interface ClaimLinkInput { id: string; participants: Participant[]; lossAt: string; }
export interface RiskExplanation {
  claimId: string;
  windowIndex: number;
  windowStart: string;
  windowEnd: string;
  relatedClaims: string[];
  triggeredNodes: TriggeredRiskNode[];
  signals: RiskSignal[];
}

type ParticipantKey = string;
const keyOf = (kind: Participant['kind'], id: string): ParticipantKey => `${kind}:${id}`;
const sortStrings = (values: Iterable<string>): string[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/**
 * Incremental shared-participant graph.
 *
 * Edges converge to the latest participant set per claim: removing a vehicle,
 * repair shop or account from a claim removes the edge immediately. Signals are
 * not accumulated during mutation; they are derived deterministically from the
 * converged graph at assessment time, scoped to tumbling time windows so claims
 * from independent windows are never merged (they can still contribute a
 * recurring-participant signal each).
 */
export class RiskGraph {
  private readonly nodes = new Map<ParticipantKey, RiskNode>();
  private readonly claimParticipants = new Map<string, Participant[]>();
  private readonly claimWindows = new Map<string, number>();
  private readonly claimLossAt = new Map<string, string>();

  constructor(private readonly windowMs: number = DEFAULT_RISK_WINDOW_MS) {}

  /** Tumbling UTC window index for an ISO timestamp. */
  windowIndexOf(lossAt: string): number {
    return RiskGraph.windowIndexOf(new Date(lossAt).getTime(), this.windowMs);
  }

  static windowIndexOf(timeMs: number, windowMs: number = DEFAULT_RISK_WINDOW_MS): number {
    return Math.floor(timeMs / windowMs);
  }

  static windowStart(windowIndex: number, windowMs: number = DEFAULT_RISK_WINDOW_MS): Date {
    return new Date(windowIndex * windowMs);
  }

  private windowBounds(windowIndex: number): { start: string; end: string } {
    return {
      start: new Date(windowIndex * this.windowMs).toISOString(),
      end: new Date((windowIndex + 1) * this.windowMs).toISOString(),
    };
  }

  /**
   * Apply the latest participant set for a claim. Edges to participants no
   * longer present are deleted and empty nodes are pruned, so the network
   * contracts when a claim's participants change.
   */
  link(claimId: string, participants: Participant[], lossAt: string): void {
    const next = this.dedupe(participants);
    const nextKeys = new Set(next.map((participant) => keyOf(participant.kind, participant.id)));
    const windowIndex = this.windowIndexOf(lossAt);

    const previous = this.claimParticipants.get(claimId) ?? [];
    for (const oldParticipant of previous) {
      const oldKey = keyOf(oldParticipant.kind, oldParticipant.id);
      if (nextKeys.has(oldKey)) continue;
      const oldNode = this.nodes.get(oldKey);
      if (!oldNode) continue;
      oldNode.claims.delete(claimId);
      if (oldNode.claims.size === 0) this.nodes.delete(oldKey);
    }

    for (const participant of next) {
      const key = keyOf(participant.kind, participant.id);
      const node = this.nodes.get(key) ?? { key, kind: participant.kind, claims: new Set<string>() };
      node.claims.add(claimId);
      this.nodes.set(key, node);
    }

    this.claimParticipants.set(claimId, next);
    this.claimWindows.set(claimId, windowIndex);
    this.claimLossAt.set(claimId, lossAt);
  }

  /** Remove every edge of a claim (used when rebuilding from a claim catalog). */
  unlinkClaim(claimId: string): void {
    const previous = this.claimParticipants.get(claimId) ?? [];
    for (const participant of previous) {
      const key = keyOf(participant.kind, participant.id);
      const node = this.nodes.get(key);
      if (!node) continue;
      node.claims.delete(claimId);
      if (node.claims.size === 0) this.nodes.delete(key);
    }
    this.claimParticipants.delete(claimId);
    this.claimWindows.delete(claimId);
    this.claimLossAt.delete(claimId);
  }

  /** Chronological, tie-broken ordering of claim ids (stable across call orders). */
  private sortedClaimIds(ids: Iterable<string>): string[] {
    return [...ids].sort((a, b) => {
      const at = this.claimLossAt.get(a) ?? '';
      const bt = this.claimLossAt.get(b) ?? '';
      return at < bt ? -1 : at > bt ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  }

  /**
   * Converge the whole projection to the current claim catalog, independent of
   * the order claims were assessed in. Claims absent from the catalog have
   * their stale edges removed.
   */
  syncAll(claims: ClaimLinkInput[]): void {
    const live = new Set(claims.map((claim) => claim.id));
    for (const claimId of [...this.claimParticipants.keys()]) {
      if (!live.has(claimId)) this.unlinkClaim(claimId);
    }
    for (const claim of claims) this.link(claim.id, claim.participants, claim.lossAt);
  }

  /** Claims sharing at least one participant within the same time window. */
  neighborhood(claimId: string): string[] {
    return this.explain(claimId).relatedClaims;
  }

  /** Whether a participant node currently exists (diagnostics/tests). */
  hasNode(kind: Participant['kind'], id: string): boolean {
    return this.nodes.has(keyOf(kind, id));
  }

  /**
   * Derive deterministic, deduplicated risk evidence for a claim. Output does
   * not depend on assessment order: nodes, claims and signals are sorted, and
   * every signal carries the triggering node, related claims and sources.
   */
  explain(claimId: string): RiskExplanation {
    const ownWindow = this.claimWindows.get(claimId);
    const bounds = this.windowBounds(ownWindow ?? 0);
    const participants = this.claimParticipants.get(claimId) ?? [];

    const signals: RiskSignal[] = [];
    const triggered = new Map<string, TriggeredRiskNode>();
    const relatedClaims = new Set<string>();

    for (const participant of participants) {
      const nodeKey = keyOf(participant.kind, participant.id);
      const node = this.nodes.get(nodeKey);
      if (!node) continue;

      // Window -> other claims sharing this node in that window.
      const byWindow = new Map<number, string[]>();
      for (const otherId of node.claims) {
        if (otherId === claimId) continue;
        const otherWindow = this.claimWindows.get(otherId);
        if (otherWindow === undefined) continue;
        const bucket = byWindow.get(otherWindow) ?? [];
        bucket.push(otherId);
        byWindow.set(otherWindow, bucket);
      }

      for (const windowIndex of [...byWindow.keys()].sort((a, b) => a - b)) {
        const otherClaims = this.sortedClaimIds(byWindow.get(windowIndex) ?? []);
        if (!otherClaims.length) continue;
        const windowBounds = this.windowBounds(windowIndex);
        const nodeSource: RiskSignalSource = { kind: 'node', id: nodeKey };
        const claimSources: RiskSignalSource[] = otherClaims.map((id) => ({ kind: 'claim', id }));
        const base = {
          nodeKind: participant.kind,
          nodeKey,
          windowIndex,
          windowStart: windowBounds.start,
          windowEnd: windowBounds.end,
          relatedClaims: otherClaims,
        };

        if (windowIndex === ownWindow) {
          for (const id of otherClaims) relatedClaims.add(id);
          signals.push({
            ...base,
            code: `SHARED_${participant.kind.toUpperCase()}`,
            score: Math.min(40, otherClaims.length * 10),
            explanation: `${participant.kind} ${participant.id} is shared with ${otherClaims.length} claim(s) in the same ${Math.round(this.windowMs / 86400000)}-day window`,
            participants: [participant.id, ...otherClaims],
            sources: [nodeSource, ...claimSources],
            dedupeKey: `shared:${nodeKey}:${windowIndex}`,
          });
          this.recordNode(triggered, nodeKey, participant.kind, windowIndex, windowBounds, [claimId, ...otherClaims], `SHARED_${participant.kind.toUpperCase()}`);
        } else {
          // A distinct window is a fresh, independently deduped piece of
          // evidence - never merged with the current window's cluster.
          signals.push({
            ...base,
            code: `RECURRING_${participant.kind.toUpperCase()}`,
            score: 5,
            explanation: `${participant.kind} ${participant.id} reappears in an independent time window with ${otherClaims.length} claim(s)`,
            participants: [participant.id, ...otherClaims],
            sources: [nodeSource, ...claimSources],
            dedupeKey: `recurring:${nodeKey}:${windowIndex}`,
          });
          this.recordNode(triggered, nodeKey, participant.kind, windowIndex, windowBounds, otherClaims, `RECURRING_${participant.kind.toUpperCase()}`);
        }
      }
    }

    signals.sort((a, b) => ((a.dedupeKey ?? '') < (b.dedupeKey ?? '') ? -1 : 1));
    const triggeredNodes = [...triggered.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.windowIndex - b.windowIndex));

    return {
      claimId,
      windowIndex: ownWindow ?? 0,
      windowStart: bounds.start,
      windowEnd: bounds.end,
      relatedClaims: this.sortedClaimIds(relatedClaims),
      triggeredNodes,
      signals,
    };
  }

  private recordNode(
    triggered: Map<string, TriggeredRiskNode>,
    nodeKey: string,
    kind: Participant['kind'],
    windowIndex: number,
    bounds: { start: string; end: string },
    claims: string[],
    signalCode: string,
  ): void {
    const key = `${nodeKey}:${windowIndex}`;
    const entry = triggered.get(key) ?? { key: nodeKey, kind, windowIndex, windowStart: bounds.start, claims: [], signals: [] };
    entry.claims = this.sortedClaimIds(new Set([...entry.claims, ...claims]));
    entry.signals = sortStrings(new Set([...entry.signals, signalCode]));
    triggered.set(key, entry);
  }

  private dedupe(participants: Participant[]): Participant[] {
    const unique = new Map<ParticipantKey, Participant>();
    for (const participant of participants) {
      const key = keyOf(participant.kind, participant.id);
      if (!unique.has(key)) unique.set(key, { ...participant });
    }
    return [...unique.values()].sort((a, b) => {
      const ak = keyOf(a.kind, a.id);
      const bk = keyOf(b.kind, b.id);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  }
}
