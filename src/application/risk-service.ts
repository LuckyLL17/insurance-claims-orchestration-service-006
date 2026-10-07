import { ClaimService } from './claim-service';
import { RiskGraph, RiskExplanation } from '../domain/risk';
import { RiskSignal } from '../domain/types';
import { stableHash } from '../domain/ids';

const LARGE_LOSS_THRESHOLD = 100_000;

export interface RiskAssessment extends RiskExplanation {
  score: number;
  fingerprint: string;
}

export class RiskService {
  constructor(private readonly claims: ClaimService, private readonly graph: RiskGraph) {}

  assess(claimId: string, actor: string) {
    const current = this.claims.get(claimId);
    const assessment = this.evaluate(claimId);
    const { score, signals, relatedClaims, triggeredNodes, fingerprint } = assessment;

    // Repeating an assessment already derived from the same network state is a
    // no-op; any participant/window change changes the fingerprint.
    if (current.riskFingerprint && current.riskFingerprint === fingerprint) return current;

    return this.claims.addEvent(
      claimId,
      'risk.assessed',
      { score, signals, relatedClaims, triggeredNodes, fingerprint },
      actor,
      `risk:${claimId}:v${current.version}:${fingerprint}`,
    );
  }

  related(claimId: string): string[] {
    return this.evaluate(claimId).relatedClaims;
  }

  explain(claimId: string): RiskAssessment {
    return this.evaluate(claimId);
  }

  /** Rebuild the graph projection from current claim states, then derive evidence. */
  private evaluate(claimId: string): RiskAssessment {
    this.syncGraph();
    const claim = this.claims.get(claimId);
    const explanation = this.graph.explain(claimId);

    const signals: RiskSignal[] = [...explanation.signals];
    if (claim.loss.gross >= LARGE_LOSS_THRESHOLD) {
      signals.push({
        code: 'LARGE_LOSS',
        score: 25,
        explanation: `gross loss ${claim.loss.gross} exceeds manual review threshold ${LARGE_LOSS_THRESHOLD}`,
        participants: [],
        sources: [{ kind: 'claim_attribute', id: 'loss.gross' }],
        dedupeKey: 'large-loss',
      });
    }
    signals.sort((a, b) => ((a.dedupeKey ?? '') < (b.dedupeKey ?? '') ? -1 : 1));

    const score = Math.min(100, signals.reduce((sum, signal) => sum + signal.score, 0));
    // Fingerprint over exactly the deterministic inputs, so the same network +
    // loss always yields the same score/signals, regardless of call order.
    const fingerprint = stableHash({
      lossGross: claim.loss.gross,
      participants: claim.participants.map((p) => `${p.kind}:${p.id}`).sort(),
      signals: signals.map((signal) => ({
        dedupeKey: signal.dedupeKey,
        score: signal.score,
        relatedClaims: signal.relatedClaims ?? [],
      })),
    }).slice(0, 16);

    return { ...explanation, signals, score, fingerprint };
  }

  /** Converge the graph to the latest participant sets and windows of every claim. */
  private syncGraph(): void {
    this.graph.syncAll(this.claims.list().map((claim) => ({ id: claim.id, participants: claim.participants, lossAt: claim.lossAt })));
  }
}
