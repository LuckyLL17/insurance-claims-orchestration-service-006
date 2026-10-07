import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { RiskGraph } from '../src/domain/risk';

const create = (app: ReturnType<typeof buildApp>, id: string, lossAt: string, participants: { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string }[], gross = 18000) =>
  app.claims.create({ policyId: 'P-100', lossAt, reportedAt: lossAt.replace('08:00', '09:00'), channel: 'agent', participants, loss: { currency: 'CNY', gross } }, 'test', `key-${id}`);

test('removing a participant prunes the stale relationship and converges the network', () => {
  const app = buildApp();
  const a = create(app, 'a', '2026-08-01T08:00:00Z', [{ kind: 'repair_shop', id: 'shop-1' }]);
  const b = create(app, 'b', '2026-08-02T08:00:00Z', [{ kind: 'repair_shop', id: 'shop-1' }, { kind: 'account', id: 'acct-1' }]);
  app.risks.assess(a.id, 'risk');
  app.risks.assess(b.id, 'risk');
  assert.deepEqual(app.risks.related(a.id), [b.id]);

  // shop-1 is corrected away on claim b; the graph must drop the old edge.
  app.risks.updateParticipants(b.id, [{ kind: 'account', id: 'acct-1' }], 'investigator');
  assert.deepEqual(app.risks.related(a.id), []);

  const reassessed = app.risks.assess(a.id, 'risk');
  assert.equal(reassessed.riskScore, 0);
  assert.deepEqual(reassessed.riskSignals, []);
});

test('does not merge claims from independent time windows but a new window contributes fresh evidence', () => {
  const app = buildApp();
  const old = create(app, 'old', '2026-06-01T08:00:00Z', [{ kind: 'vehicle', id: 'car-x' }]);
  const recent = create(app, 'recent', '2026-10-01T08:00:00Z', [{ kind: 'vehicle', id: 'car-x' }]);
  app.risks.assess(old.id, 'risk');
  const recentAssessed = app.risks.assess(recent.id, 'risk');
  // Same vehicle but ~88 days apart is outside the 90-day window: no merge.
  assert.equal(recentAssessed.riskScore, 0);
  assert.deepEqual(app.risks.related(recent.id), []);

  // A fresh claim within the window links normally and contributes new evidence.
  const fresh = create(app, 'fresh', '2026-10-05T08:00:00Z', [{ kind: 'vehicle', id: 'car-x' }]);
  const freshAssessed = app.risks.assess(fresh.id, 'risk');
  assert.equal(freshAssessed.riskScore, 10);
  assert.deepEqual(app.risks.related(fresh.id), [recent.id]);
  assert.ok(!app.risks.related(fresh.id).includes(old.id));
});

test('deduplicates repeated participants and risk assessment is idempotent and reproducible', () => {
  const app = buildApp();
  const a = create(app, 'a', '2026-08-01T08:00:00Z', [
    { kind: 'person', id: 'p-1' }, { kind: 'person', id: 'p-1' },
    { kind: 'account', id: 'acct-1' },
  ]);
  const b = create(app, 'b', '2026-08-02T08:00:00Z', [
    { kind: 'person', id: 'p-1' }, { kind: 'account', id: 'acct-1' },
  ]);
  app.risks.assess(a.id, 'risk');
  const first = app.risks.assess(b.id, 'risk');
  // One signal per shared node, never double counted for the duplicate person.
  assert.equal(first.riskSignals.length, 2);
  assert.equal(first.riskScore, 20);
  assert.deepEqual(first.riskSignals.map((s) => s.code), ['SHARED_ACCOUNT', 'SHARED_PERSON']);

  // Repeated assessment with unchanged inputs is idempotent: same stored event,
  // same version and the score does not accumulate.
  const again = app.risks.assess(b.id, 'risk');
  assert.equal(again.version, first.version);
  assert.equal(again.riskScore, 20);

  // Rebuilding the graph from the same claims yields identical signals.
  const rebuilt = new RiskGraph();
  rebuilt.rebuild([
    { id: a.id, participants: a.participants, lossAt: a.lossAt },
    { id: b.id, participants: b.participants, lossAt: b.lossAt },
  ]);
  assert.deepEqual(
    rebuilt.signalsFor(b.id).map((s) => ({ code: s.code, score: s.score, relatedClaims: s.relatedClaims })),
    first.riskSignals.map((s) => ({ code: s.code, score: s.score, relatedClaims: s.relatedClaims })),
  );
});

test('a change in a related claim produces a fresh assessment instead of a cached score', () => {
  const app = buildApp();
  const a = create(app, 'a', '2026-09-01T08:00:00Z', [{ kind: 'repair_shop', id: 'shop-2' }]);
  const b = create(app, 'b', '2026-09-02T08:00:00Z', [{ kind: 'repair_shop', id: 'shop-2' }]);
  // A assessed first, before any shared-party link exists.
  const before = app.risks.assess(a.id, 'risk');
  assert.equal(before.riskScore, 0);
  // B joins the network; the neighborhood changed.
  app.risks.assess(b.id, 'risk');
  const after = app.risks.assess(a.id, 'risk');
  assert.equal(after.riskScore, 10);
  assert.ok(after.version > before.version);
});

test('exposes the trigger node, related claims and source for every signal', () => {
  const app = buildApp();
  const a = create(app, 'a', '2026-08-01T08:00:00Z', [{ kind: 'person', id: 'p-9' }]);
  const b = create(app, 'b', '2026-08-03T08:00:00Z', [{ kind: 'person', id: 'p-9' }], 120000);
  app.risks.assess(a.id, 'risk');
  app.risks.assess(b.id, 'risk');

  const explanation = app.risks.explain(b.id);
  assert.deepEqual(explanation.relatedClaims, [a.id]);
  const shared = explanation.signals.find((s) => s.code === 'SHARED_PERSON')!;
  assert.deepEqual(shared.node, { kind: 'person', id: 'p-9' });
  assert.deepEqual(shared.relatedClaims, [a.id]);
  assert.equal(shared.source?.type, 'graph');
  assert.equal(shared.source?.rule, 'SHARED_PERSON');
  assert.ok(shared.source?.detail.includes(a.id));

  const large = explanation.signals.find((s) => s.code === 'LARGE_LOSS')!;
  assert.equal(large.score, 25);
  assert.equal(large.source?.type, 'claim');
  assert.equal(explanation.score, 35);
  assert.ok(explanation.links.some((link) => link.node.id === 'p-9' && link.relatedClaims.includes(a.id)));
});
