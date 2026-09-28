import * as fs from 'fs'
import * as path from 'path'
import { loadPricingConfig, resolveActivePricing, type PricingConfig } from './core/pricing.js'
import type { OperationalMetrics } from './core/tokenLedger.js'
import { ledgerPath } from './ledger-path.js'

export interface PricingRates {
  inputPerMillion: number
  inputCachedPerMillion: number
  outputPerMillion: number
}

export type RouteType = 'ARCHITECT_CLOUD' | 'WORKER_LOCAL' | 'local' | 'cloud' | 'cloud-failover'

export interface StepUsage {
  turn?: number
  route: RouteType
  provider?: string
  model?: string
  reason?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens?: number
  accepted?: boolean
}

function requireNonNegativeFinite(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
export interface TurnRecord {
  turn: number
  timestamp: string
  route: RouteType
  provider: string
  model: string
  routingReason: string
  promptTokensEst: number
  completionTokensEst: number
  totalTokensEst: number
  cacheHitRateEst: number
  costUSD: number
  savedUSD: number
  benchmark?: string
  accepted?: boolean
}

export interface LedgerSummary {
  totalTurns: number
  totalTokens?: number
  localTurns: number
  cloudTurns: number
  architectTurns: number
  workerTurns: number
  failoverTurns: number
  totalLocalTokens: number
  totalCloudTokens: number
  totalSpendUSD?: number
  totalCostUSD: number
  totalSavedUSD: number
  recentEvents?: TurnRecord[]
  history: TurnRecord[]
  operationalMetrics?: OperationalMetrics
  acceptedPromptTokens?: number
  acceptedCompletionTokens?: number
  retryWastePromptTokens?: number
  retryWasteCompletionTokens?: number
}

export class SavingsTracker {
  private ledgerPath: string
  private rates: PricingRates
  private localPromptRate: number
  private localCompletionRate: number
  private benchmarkName: string
  private activeTurns = new Map<
    number,
    {
      route: RouteType
      provider: string
      model: string
      routingReason: string
      promptText: string
      completionText: string
      exactCompletionTokens?: number
    }
  >()

  constructor(baseDir?: string, rates?: Partial<PricingRates>, pricingConfig?: PricingConfig) {
    this.ledgerPath = ledgerPath(baseDir)
    const config = pricingConfig ?? loadPricingConfig()
    const active = resolveActivePricing(config)
    const cloud = config.cloudRates ?? { inputPerMillion: active.tier.promptPerMillion, inputCachedPerMillion: active.tier.promptPerMillion, outputPerMillion: active.tier.completionPerMillion }
    this.benchmarkName = active.benchmark
    this.localPromptRate = rates?.inputPerMillion ?? active.tier.promptPerMillion
    this.localCompletionRate = rates?.outputPerMillion ?? active.tier.completionPerMillion
    this.rates = {
      inputPerMillion: rates?.inputPerMillion ?? cloud.inputPerMillion,
      inputCachedPerMillion: rates?.inputCachedPerMillion ?? cloud.inputCachedPerMillion,
      outputPerMillion: rates?.outputPerMillion ?? cloud.outputPerMillion,
    }
  }

  public getBenchmark(): string {
    return this.benchmarkName
  }

  private estimateTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 3.8)
  }

  public recordUsage(usage: StepUsage): TurnRecord {
    const turn = usage.turn ?? 1
    const route = usage.route || 'ARCHITECT_CLOUD'
    const model = usage.model || (route === 'WORKER_LOCAL' || route === 'local' ? 'qwen/qwen3.8-27b' : 'deepseek-chat')
    const reason = usage.reason || 'STEP_COMPLETION'
    const accepted = usage.accepted !== false

    const promptTokens = requireNonNegativeFinite(usage.promptTokens ?? 0, 'promptTokens');
    const completionTokens = requireNonNegativeFinite(usage.completionTokens ?? 0, 'completionTokens');
    const totalTokens = requireNonNegativeFinite(usage.totalTokens ?? (promptTokens + completionTokens), 'totalTokens');
    const rawCacheHitTokens = requireNonNegativeFinite(usage.cacheHitTokens ?? 0, 'cacheHitTokens');
    if (rawCacheHitTokens > promptTokens) throw new Error('cacheHitTokens cannot exceed promptTokens');
    const cacheHitTokens = Math.min(promptTokens, rawCacheHitTokens)
    const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens)

    let costUSD = 0
    let savedUSD = 0

    const isLocal = route === 'WORKER_LOCAL' || route === 'local'

    if (isLocal) {
      costUSD = 0
      savedUSD = accepted ? parseFloat(
        ((promptTokens * this.localPromptRate + completionTokens * this.localCompletionRate) / 1_000_000).toFixed(6)
      ) : 0
    } else {
      savedUSD = 0
      costUSD = parseFloat(
        ((
          cacheHitTokens * this.rates.inputCachedPerMillion +
          cacheMissTokens * this.rates.inputPerMillion +
          completionTokens * this.rates.outputPerMillion
        ) / 1_000_000).toFixed(6)
      )
    }

    const cacheHitRateEst = promptTokens > 0 ? parseFloat((cacheHitTokens / promptTokens).toFixed(2)) : 0

    const record: TurnRecord = {
      turn,
      timestamp: new Date().toISOString(),
      route,
      provider: usage.provider ?? (isLocal ? 'lm-studio' : 'deepseek-official'),
      model,
      routingReason: reason,
      promptTokensEst: promptTokens,
      completionTokensEst: completionTokens,
      totalTokensEst: totalTokens,
      cacheHitRateEst,
      costUSD,
      savedUSD,
      benchmark: this.benchmarkName,
      accepted,
    }

    this.persist(record)

    const auditMsg = `[LEDGER_AUDIT] Step ${turn} [${route.toUpperCase()}] -> Reason: ${reason} | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens}, CacheHit: ${cacheHitTokens}) | Cost: $${costUSD.toFixed(6)} | Saved: $${savedUSD.toFixed(6)}`
    console.error(auditMsg)

    return record
  }

  public startTurn(
    turn: number,
    route: RouteType,
    provider: string,
    model: string,
    promptText: string,
    routingReason: string = 'STANDARD_ROUTING'
  ) {
    this.activeTurns.set(turn, {
      route,
      provider,
      model,
      routingReason,
      promptText,
      completionText: '',
    })
  }

  public updateTurnRoute(
    turn: number,
    route: RouteType,
    provider: string,
    model: string,
    routingReason: string
  ) {
    const active = this.activeTurns.get(turn)
    if (active) {
      active.route = route
      active.provider = provider
      active.model = model
      active.routingReason = routingReason
      active.completionText = ''
      delete active.exactCompletionTokens
    }
  }

  public accumulateChunk(turn: number, textChunk: string) {
    const active = this.activeTurns.get(turn)
    if (active && textChunk) {
      active.completionText += textChunk
    }
  }

  public recordCompletionTokens(turn: number, count: number) {
    const active = this.activeTurns.get(turn)
    if (active && count > 0) {
      active.exactCompletionTokens = count
    }
  }

  public endTurn(turn: number): TurnRecord | null {
    const active = this.activeTurns.get(turn)
    if (!active) return null

    this.activeTurns.delete(turn)

    const promptTokens = this.estimateTokens(active.promptText)
    const completionTokens = active.exactCompletionTokens ?? this.estimateTokens(active.completionText)
    const totalTokens = promptTokens + completionTokens

    return this.recordUsage({
      turn,
      route: active.route,
      model: active.model,
      reason: active.routingReason || 'TURN_COMPLETION',
      promptTokens,
      completionTokens,
      totalTokens,
    })
  }

  public recordOperationalMetrics(metrics: OperationalMetrics): void {
    if (!Number.isFinite(metrics.contextTokensShielded) || metrics.contextTokensShielded < 0 ||
      !Number.isFinite(metrics.estimatedBytesAvoided) || metrics.estimatedBytesAvoided < 0 ||
      !Number.isFinite(metrics.estimatedCloudMessagesSaved) || metrics.estimatedCloudMessagesSaved < 0 ||
      !Number.isFinite(metrics.savedUSD) || metrics.savedUSD < 0 || !metrics.benchmarkModel ||
      !Number.isFinite(metrics.acceptedCompletionTokens) || metrics.acceptedCompletionTokens < 0 ||
      !Number.isFinite(metrics.acceptedPromptTokens) || metrics.acceptedPromptTokens < 0 ||
      !Number.isFinite(metrics.retryWasteCompletionTokens) || metrics.retryWasteCompletionTokens < 0 ||
      !Number.isFinite(metrics.retryWastePromptTokens) || metrics.retryWastePromptTokens < 0) {
      throw new Error('Invalid operational metrics');
    }
    const ledger = fs.existsSync(this.ledgerPath)
      ? JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as LedgerSummary
      : { totalTurns: 0, totalTokens: 0, localTurns: 0, cloudTurns: 0, architectTurns: 0, workerTurns: 0, failoverTurns: 0, totalLocalTokens: 0, totalCloudTokens: 0, totalSpendUSD: 0, totalCostUSD: 0, totalSavedUSD: 0, recentEvents: [], history: [] } as LedgerSummary;
    const previous = ledger.operationalMetrics;
    if (previous) {
      requireNonNegativeFinite(previous.contextTokensShielded, 'ledger.contextTokensShielded');
      requireNonNegativeFinite(previous.estimatedBytesAvoided, 'ledger.estimatedBytesAvoided');
      requireNonNegativeFinite(previous.estimatedCloudMessagesSaved, 'ledger.estimatedCloudMessagesSaved');
      requireNonNegativeFinite(previous.savedUSD, 'ledger.savedUSD');
      requireNonNegativeFinite(previous.acceptedCompletionTokens ?? 0, 'ledger.acceptedCompletionTokens');
      requireNonNegativeFinite(previous.acceptedPromptTokens ?? 0, 'ledger.acceptedPromptTokens');
      requireNonNegativeFinite(previous.retryWasteCompletionTokens ?? 0, 'ledger.retryWasteCompletionTokens');
      requireNonNegativeFinite(previous.retryWastePromptTokens ?? 0, 'ledger.retryWastePromptTokens');
      if (typeof previous.benchmarkModel !== 'string' || !previous.benchmarkModel) throw new Error('Invalid ledger.benchmarkModel');
    }
    ledger.operationalMetrics = {
      contextTokensShielded: (previous?.contextTokensShielded ?? 0) + metrics.contextTokensShielded,
      estimatedBytesAvoided: (previous?.estimatedBytesAvoided ?? 0) + metrics.estimatedBytesAvoided,
      estimatedCloudMessagesSaved: Number((((previous?.acceptedCompletionTokens ?? 0) + metrics.acceptedCompletionTokens) / 1500).toFixed(2)),
      savedUSD: parseFloat(((previous?.savedUSD ?? 0) + metrics.savedUSD).toFixed(6)),      benchmarkModel: metrics.benchmarkModel,
      acceptedCompletionTokens: (previous?.acceptedCompletionTokens ?? 0) + metrics.acceptedCompletionTokens,
      acceptedPromptTokens: (previous?.acceptedPromptTokens ?? 0) + metrics.acceptedPromptTokens,
      retryWasteCompletionTokens: (previous?.retryWasteCompletionTokens ?? 0) + metrics.retryWasteCompletionTokens,
      retryWastePromptTokens: (previous?.retryWastePromptTokens ?? 0) + metrics.retryWastePromptTokens,
    };
    this.writeLedger(ledger);
  }

  private persist(record: TurnRecord) {
    let ledger: LedgerSummary = {
      totalTurns: 0,
      totalTokens: 0,
      localTurns: 0,
      cloudTurns: 0,
      architectTurns: 0,
      workerTurns: 0,
      failoverTurns: 0,
      totalLocalTokens: 0,
      totalCloudTokens: 0,
      totalSpendUSD: 0,
      totalCostUSD: 0,
      totalSavedUSD: 0,
      acceptedPromptTokens: 0,
      acceptedCompletionTokens: 0,
      retryWastePromptTokens: 0,
      retryWasteCompletionTokens: 0,
      recentEvents: [],
      history: [],
    }

    if (fs.existsSync(this.ledgerPath)) {
      const raw = fs.readFileSync(this.ledgerPath, 'utf8')
      ledger = JSON.parse(raw)
      ledger.acceptedPromptTokens ??= 0
      ledger.acceptedCompletionTokens ??= 0
      ledger.retryWastePromptTokens ??= 0
      ledger.retryWasteCompletionTokens ??= 0
      for (const key of ['totalTurns', 'totalTokens', 'localTurns', 'cloudTurns', 'architectTurns', 'workerTurns', 'failoverTurns', 'totalLocalTokens', 'totalCloudTokens', 'totalSpendUSD', 'totalCostUSD', 'totalSavedUSD', 'acceptedPromptTokens', 'acceptedCompletionTokens', 'retryWastePromptTokens', 'retryWasteCompletionTokens'] as const) {
        if (typeof ledger[key] !== 'number' || !Number.isFinite(ledger[key]) || ledger[key] < 0) throw new Error(`Invalid ledger field: ${key}`)
      }
      if (!Array.isArray(ledger.history)) throw new Error('Invalid ledger history')
      ledger.acceptedPromptTokens ??= 0
      ledger.acceptedCompletionTokens ??= 0
      ledger.retryWastePromptTokens ??= 0
      ledger.retryWasteCompletionTokens ??= 0
    }

    ledger.totalTurns += 1
    ledger.totalTokens = (ledger.totalTokens || 0) + record.totalTokensEst

    if (record.route === 'WORKER_LOCAL' || record.route === 'local') {
      ledger.localTurns += 1
      if (record.route === 'WORKER_LOCAL') ledger.workerTurns = (ledger.workerTurns || 0) + 1
      ledger.totalLocalTokens += record.totalTokensEst
      if (record.accepted === false) {
        ledger.retryWastePromptTokens = (ledger.retryWastePromptTokens || 0) + record.promptTokensEst
        ledger.retryWasteCompletionTokens = (ledger.retryWasteCompletionTokens || 0) + record.completionTokensEst
      } else {
        ledger.acceptedPromptTokens = (ledger.acceptedPromptTokens || 0) + record.promptTokensEst
        ledger.acceptedCompletionTokens = (ledger.acceptedCompletionTokens || 0) + record.completionTokensEst
        ledger.totalSavedUSD = parseFloat(((ledger.totalSavedUSD || 0) + record.savedUSD).toFixed(6))
      }
    } else if (record.route === 'cloud-failover') {
      ledger.failoverTurns = (ledger.failoverTurns || 0) + 1
      ledger.totalCloudTokens += record.totalTokensEst
      ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6))
      ledger.totalSpendUSD = ledger.totalCostUSD
    } else {
      ledger.cloudTurns += 1
      if (record.route === 'ARCHITECT_CLOUD') ledger.architectTurns = (ledger.architectTurns || 0) + 1
      ledger.totalCloudTokens += record.totalTokensEst
      ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6))
      ledger.totalSpendUSD = ledger.totalCostUSD
    }

    ledger.history.push(record)

    if (ledger.history.length > 500) {
      ledger.history = ledger.history.slice(-500)
    }
    ledger.recentEvents = ledger.history.slice(-50)

    this.writeLedger(ledger)
  }

  private writeLedger(ledger: LedgerSummary): void {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const temporaryPath = `${this.ledgerPath}.${process.pid}.tmp`;
    let created = false;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2), { encoding: 'utf8', flag: 'wx' });
      created = true;
      fs.renameSync(temporaryPath, this.ledgerPath);
    } finally {
      if (created && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

}


