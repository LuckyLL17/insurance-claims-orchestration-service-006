import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { RiskGraph } from '../src/domain/risk';
import { Participant } from '../src/domain/types';

const base = {
  policyId: 'P-100',
  channel: 'agent',
  loss: { currency: 'CNY', gross: 18000 },
};

function createClaim(app: ReturnType<typeof buildApp>, id: string, lossAt: string, participants: Participant[], gross = 18000) {
  return app.claims.create(
    { ...base, lossAt, reportedAt: lossAt, participants, loss: { currency: 'CNY', gross } },
    'test',
    `key-${id}`,
  );
}

test('graph.link removes edges for dropped participants and prunes empty nodes', () => {
  const graph = new RiskGraph();
  graph.link('C1', [{ kind: 'vehicle', id: 'car-1' }, { kind: 'repair_shop', id: 'shop-1' }], '2026-08-01T08:00:00Z');
  graph.link('C2', [{ kind: 'vehicle', id: 'car-1' }, { kind: 'repair_shop', id: 'shop-1' }], '2026-08-15T08:00:00Z');
  assert.deepEqual(graph.neighborhood('C1'), ['C2']);
  assert.deepEqual(graph.neighborhood('C2'), ['C1']);

  // C2 drops both shared parties: stale edges must disappear, not be retained.
  graph.link('C2', [{ kind: 'person', id: 'driver-2' }], '2026-08-15T08:00:00Z');
  assert.deepEqual(graph.neighborhood('C1'), []);
  assert.deepEqual(graph.neighborhood('C2'), []);
  // repair_shop:shop-1 now belongs to C1 only and still exists...
  assert.equal(graph.hasNode('repair_shop', 'shop-1'), true);
  // ...until C1 drops it too, at which point the empty node is pruned.
  graph.link('C1', [{ kind: 'vehicle', id: 'car-1' }], '2026-08-01T08:00:00Z');
  assert.equal(graph.hasNode('repair_shop', 'shop-1'), false);

  // syncAll drops edges of claims absent from the catalog as well.
  graph.syncAll([{ id: 'C1', participants: [{ kind: 'vehicle', id: 'car-1' }], lossAt: '2026-08-01T08:00:00Z' }]);
  assert.equal(graph.hasNode('person', 'driver-2'), false);
});

test('network converges when a claim participant set is updated through the service', () => {
  const app = buildApp();
  const c1 = createClaim(app, 'c1', '2026-08-01T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }, { kind: 'repair_shop', id: 'shop-1' }]);
  const c2 = createClaim(app, 'c2', '2026-08-15T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }, { kind: 'repair_shop', id: 'shop-1' }]);

  const first = app.risks.assess(c1.id, 'risk');
  assert.equal(first.riskScore, 20);
  assert.deepEqual(first.riskRelatedClaims, [c2.id]);

  app.claims.updateParticipants(c2.id, [{ kind: 'person', id: 'driver-2' }], 'risk');
  const converged = app.risks.assess(c1.id, 'risk');
  assert.equal(converged.riskScore, 0);
  assert.deepEqual(converged.riskRelatedClaims, []);
  assert.deepEqual(converged.riskTriggeredNodes, []);
  assert.deepEqual(app.risks.related(c1.id), []);
});

test('claims in different windows are not merged but each window contributes fresh evidence', () => {
  const app = buildApp();
  const c1 = createClaim(app, 'c1', '2026-08-01T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }]);
  const c2 = createClaim(app, 'c2', '2026-04-01T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }]);
  const c3 = createClaim(app, 'c3', '2026-01-10T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }]);

  const explanation = app.risks.explain(c1.id);
  // Independent windows never merge into the related-claim cluster.
  assert.deepEqual(explanation.relatedClaims, []);
  const recurring = explanation.signals.filter((s) => s.code === 'RECURRING_VEHICLE');
  assert.equal(recurring.length, 2);
  assert.deepEqual(recurring.map((s) => s.windowIndex), [227, 228]);
  for (const signal of recurring) {
    assert.equal(signal.nodeKey, 'vehicle:car-1');
    assert.equal(signal.score, 5);
    assert.ok(signal.sources?.some((src) => src.kind === 'node' && src.id === 'vehicle:car-1'));
  }
  assert.deepEqual(recurring.find((s) => s.windowIndex === 227)?.relatedClaims, [c3.id]);
  assert.deepEqual(recurring.find((s) => s.windowIndex === 228)?.relatedClaims, [c2.id]);
  assert.equal(explanation.score, 10);

  // A same-window claim merges as the cluster; the recurring evidence still counts.
  const c4 = createClaim(app, 'c4', '2026-08-15T08:00:00Z', [{ kind: 'vehicle', id: 'car-1' }]);
  const merged = app.risks.assess(c1.id, 'risk');
  assert.deepEqual(merged.riskRelatedClaims, [c4.id]);
  assert.equal(merged.riskSignals.find((s) => s.code === 'SHARED_VEHICLE')?.score, 10);
  assert.equal(
    merged.riskSignals.filter((s) => s.code === 'RECURRING_VEHICLE').length,
    2,
    'recurring signals are deduped per independent window, not accumulated per claim',
  );
  assert.equal(merged.riskScore, 20);
});

test('signals are deduplicated per node/window, deterministic in order and reproducible', () => {
  const build = (order: [string, string][]) => {
    const app = buildApp();
    const ids: Record<string, string> = {};
    for (const [name, lossAt] of order) {
      const claim = createClaim(app, name, lossAt, [{ kind: 'account', id: 'acct-1' }]);
      ids[name] = claim.id;
    }
    return { app, ids };
  };
  const dates: [string, string][] = [
    ['a', '2026-08-01T08:00:00Z'],
    ['b', '2026-08-10T08:00:00Z'],
    ['c', '2026-08-20T08:00:00Z'],
  ];

  const first = build(dates);
  const second = build([...dates].reverse());
  const e1 = first.app.risks.explain(first.ids.a);
  const e2 = second.app.risks.explain(second.ids.a);
  const shape = (e: typeof e1) => ({
    score: e.score,
    signals: e.signals.map((s) => ({ code: s.code, score: s.score, dedupeKey: s.dedupeKey, windowIndex: s.windowIndex, relatedCount: s.relatedClaims?.length })),
  });
  assert.deepEqual(shape(e1), shape(e2));
  assert.equal(e1.score, 20);
  // One signal for the node/window even though two other claims share it.
  assert.equal(e1.signals.filter((s) => s.dedupeKey === 'shared:account:acct-1:229').length, 1);
  assert.deepEqual(e1.signals[0].relatedClaims, [first.ids.b, first.ids.c]);

  // Repeated assessment is idempotent and reproduces the same stored result.
  const assessedOnce = first.app.risks.assess(first.ids.a, 'risk');
  const assessedTwice = first.app.risks.assess(first.ids.a, 'risk');
  assert.equal(assessedTwice.version, assessedOnce.version);
  assert.equal(assessedTwice.riskScore, 20);
  assert.equal(assessedTwice.riskFingerprint, assessedOnce.riskFingerprint);
  assert.deepEqual(assessedTwice.riskSignals, assessedOnce.riskSignals);

  // Symmetric: both sides of a shared node see the same node/window evidence.
  const fromB = first.app.risks.explain(first.ids.b);
  assert.equal(fromB.score, 20);
  assert.deepEqual(fromB.signals[0].relatedClaims, [first.ids.a, first.ids.c]);
});

test('network change on another claim produces fresh evidence on re-assessment, then converges again', () => {
  const app = buildApp();
  const c1 = createClaim(app, 'c1', '2026-08-01T08:00:00Z', [{ kind: 'person', id: 'person-1' }]);
  const clean = app.risks.assess(c1.id, 'risk');
  assert.equal(clean.riskScore, 0);

  // A new claim sharing the person appears: re-assessment must not be suppressed.
  const c2 = createClaim(app, 'c2', '2026-08-16T08:00:00Z', [{ kind: 'person', id: 'person-1' }]);
  const linked = app.risks.assess(c1.id, 'risk');
  assert.equal(linked.version, clean.version + 1);
  assert.equal(linked.riskScore, 10);
  assert.deepEqual(linked.riskRelatedClaims, [c2.id]);

  // New claim removes the shared person: the network contracts again.
  app.claims.updateParticipants(c2.id, [{ kind: 'person', id: 'person-9' }], 'risk');
  const converged = app.risks.assess(c1.id, 'risk');
  assert.equal(converged.riskScore, 0);
  assert.deepEqual(converged.riskRelatedClaims, []);

  // Assessing once more with no network/claim change is a no-op (same event).
  const again = app.risks.assess(c1.id, 'risk');
  assert.equal(again.version, converged.version);
  assert.equal(again.riskFingerprint, converged.riskFingerprint);
});

test('assessment reports triggering nodes, related claims and per-signal sources including large loss', () => {
  const app = buildApp();
  const c1 = createClaim(app, 'c1', '2026-08-01T08:00:00Z', [{ kind: 'account', id: 'acct-9' }], 120_000);
  const c2 = createClaim(app, 'c2', '2026-08-12T08:00:00Z', [{ kind: 'account', id: 'acct-9' }], 5_000);

  const assessed = app.risks.assess(c1.id, 'risk');
  assert.equal(assessed.riskScore, 35); // SHARED_ACCOUNT 10 + LARGE_LOSS 25

  const shared = assessed.riskSignals.find((s) => s.code === 'SHARED_ACCOUNT');
  assert.ok(shared);
  assert.equal(shared?.nodeKey, 'account:acct-9');
  assert.deepEqual(shared?.relatedClaims, [c2.id]);
  assert.deepEqual(shared?.sources, [{ kind: 'node', id: 'account:acct-9' }, { kind: 'claim', id: c2.id }]);

  const largeLoss = assessed.riskSignals.find((s) => s.code === 'LARGE_LOSS');
  assert.equal(largeLoss?.score, 25);
  assert.deepEqual(largeLoss?.sources, [{ kind: 'claim_attribute', id: 'loss.gross' }]);

  assert.deepEqual(assessed.riskTriggeredNodes, [{
    key: 'account:acct-9',
    kind: 'account',
    windowIndex: 229,
    windowStart: shared?.windowStart,
    claims: [c1.id, c2.id],
    signals: ['SHARED_ACCOUNT'],
  }]);
});
