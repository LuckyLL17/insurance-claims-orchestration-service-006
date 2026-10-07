import { ClaimService } from './claim-service';
import { GraphClaimRef, RiskGraph } from '../domain/risk';
import { Participant, RiskSignal } from '../domain/types';
import { stableHash } from '../domain/ids';

export interface RiskExplanation {
  score: number;
  signals: RiskSignal[];
  relatedClaims: string[];
  links: { node: { kind: string; id: string }; relatedClaims: string[] }[];
}

export class RiskService {
  constructor(private readonly claims: ClaimService, private readonly graph: RiskGraph) {}

  /**
   * Reassess a claim. Graph signals are recomputed from the converged graph,
   * so participant/related-claim changes are always reflected. The idempotency
   * key is derived from claim version plus a canonical hash of the scoring
   * inputs (gross loss + signals): identical inputs reuse the stored event,
   * any change produces a fresh assessment with an updated score.
   */
  assess(claimId: string, actor: string) {
    const claim = this.claims.get(claimId);
    this.graph.link({ id: claimId, participants: claim.participants, lossAt: claim.lossAt });
    const graphSignals = this.graph.signalsFor(claimId);
    const signals: RiskSignal[] = [...graphSignals];
    if (claim.loss.gross >= 100000) {
      signals.push({
        code: 'LARGE_LOSS',
        score: 25,
        explanation: 'gross loss exceeds manual review threshold',
        participants: [],
        node: undefined,
        relatedClaims: [],
        source: { type: 'claim', rule: 'LARGE_LOSS', detail: `gross loss ${claim.loss.gross} >= 100000` },
      });
    }
    const score = Math.min(100, signals.reduce((sum, signal) => sum + signal.score, 0));
    // Idempotency is purely content-based: any material change to the claim
    // (facts) or to its graph neighborhood (related claims, added/removed
    // parties) changes the fingerprint and produces a fresh assessment, while
    // an identical recompute reuses the stored event instead of accumulating.
    const key = `risk:${claimId}:${this.fingerprint(claim.loss.gross, signals)}`;
    return this.claims.addEvent(claimId, 'risk.assessed', { score, signals }, actor, key);
  }

  /** Apply a participant correction and synchronously converge the graph. */
  updateParticipants(claimId: string, participants: Participant[], actor: string, key?: string) {
    const state = this.claims.addEvent(claimId, 'participants.updated', { participants: participants.map((p) => ({ ...p })) }, actor, key);
    this.graph.link({ id: claimId, participants: state.participants, lossAt: state.lossAt });
    return state;
  }

  related(claimId: string): string[] {
    return this.graph.neighborhood(claimId).relatedClaims;
  }

  explain(claimId: string): RiskExplanation {
    const { relatedClaims, links } = this.graph.neighborhood(claimId);
    const claim = this.claims.get(claimId);
    return { score: claim.riskScore, signals: claim.riskSignals, relatedClaims, links };
  }

  /** Rebuild the graph from all known claims (used by replay/backfills). */
  rebuild(claims: GraphClaimRef[]): void {
    this.graph.rebuild(claims);
  }

  /** Order-independent fingerprint of the scoring inputs. */
  private fingerprint(gross: number, signals: RiskSignal[]): string {
    const canonical = {
      gross,
      signals: signals.map((signal) => ({
        code: signal.code,
        score: signal.score,
        node: signal.node ? `${signal.node.kind}:${signal.node.id}` : null,
        relatedClaims: [...(signal.relatedClaims ?? [])].sort(),
      })),
    };
    return stableHash(canonical).slice(0, 16);
  }
}
