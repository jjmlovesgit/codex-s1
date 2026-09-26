import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SavingsTracker } from '../src/savings-tracker'

describe('SavingsTracker Test Suite', () => {
  const tmpDir = path.join(process.cwd(), 'tmp_test_ledger')

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (e) {}
  })

  it('Calculates non-zero cost for ARCHITECT_CLOUD with cache hits', () => {
    const tracker = new SavingsTracker(tmpDir)

    const summary = tracker.recordUsage({
      turn: 1,
      route: 'ARCHITECT_CLOUD',
      model: 'deepseek-chat',
      reason: 'STEP_COMPLETION',
      promptTokens: 10000,
      completionTokens: 2000,
      totalTokens: 12000,
      cacheHitTokens: 8000,
    })

    expect(summary).not.toBeNull()
    expect(summary.route).toBe('ARCHITECT_CLOUD')
    expect(summary.promptTokensEst).toBe(10000)
    expect(summary.completionTokensEst).toBe(2000)
    expect(summary.totalTokensEst).toBe(12000)
    expect(summary.costUSD).toBeGreaterThan(0)
    expect(summary.savedUSD).toBe(0)

    // Cost calc: 8000 * 0.014/1M + 2000 * 0.14/1M + 2000 * 0.28/1M = 0.000112 + 0.000280 + 0.000560 = 0.000952
    expect(summary.costUSD).toBe(0.000952)

    const ledgerFile = path.join(tmpDir, 'savings-ledger.json')
    expect(fs.existsSync(ledgerFile)).toBe(true)

    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    expect(ledger.totalTurns).toBe(1)
    expect(ledger.totalTokens).toBe(12000)
    expect(ledger.cloudTurns).toBe(1)
    expect(ledger.totalCloudTokens).toBe(12000)
    expect(ledger.totalCostUSD).toBe(0.000952)
    expect(ledger.recentEvents).toHaveLength(1)
  })

  it('Calculates positive savings for WORKER_LOCAL turns', () => {
    const tracker = new SavingsTracker(tmpDir)

    const summary = tracker.recordUsage({
      turn: 2,
      route: 'WORKER_LOCAL',
      model: 'qwen/qwen3.8-27b',
      reason: 'SUBAGENT_DELEGATION',
      promptTokens: 10000,
      completionTokens: 2000,
      totalTokens: 12000,
    })

    expect(summary).not.toBeNull()
    expect(summary.route).toBe('WORKER_LOCAL')
    expect(summary.costUSD).toBe(0)
    // Saved calc: 10000 * 2.50/1M + 2000 * 10.00/1M = 0.025 + 0.020 = 0.045
    expect(summary.savedUSD).toBe(0.045)

    const ledgerFile = path.join(tmpDir, 'savings-ledger.json')
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    expect(ledger.totalTurns).toBe(1)
    expect(ledger.workerTurns).toBe(1)
    expect(ledger.totalLocalTokens).toBe(12000)
    expect(ledger.totalSavedUSD).toBe(0.045)
  })
})
