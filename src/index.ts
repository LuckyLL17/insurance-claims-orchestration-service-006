import { EventStore } from './application/event-store';
import { ClaimService } from './application/claim-service';
import { PaymentService } from './application/payment-service';
import { RiskService } from './application/risk-service';
import { TaskService } from './application/task-service';
import { ReplayService } from './application/replay-service';
import { EvidenceLedger } from './domain/evidence';
import { PaymentLedger } from './domain/payment-ledger';
import { PolicyCatalog } from './domain/policy';
import { RiskGraph, DEFAULT_RISK_WINDOW_MS } from './domain/risk';
import { RuleEngine } from './domain/rules';
import { TaskBoard } from './domain/task';
import { startServer } from './http/server';

export interface BuildAppOptions { riskWindowMs?: number; }

export function buildApp(options: BuildAppOptions = {}) {
  const events = new EventStore(); const policies = new PolicyCatalog(); const rules = new RuleEngine(); const claims = new ClaimService(events, policies, rules, new EvidenceLedger());
  const graph = new RiskGraph(options.riskWindowMs ?? DEFAULT_RISK_WINDOW_MS);
  return { claims, payments: new PaymentService(claims, new PaymentLedger()), risks: new RiskService(claims, graph), tasks: new TaskService(claims, new TaskBoard()), replay: new ReplayService(events, claims), rules };
}

if (require.main === module) void startServer(buildApp());
