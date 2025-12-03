import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface SmartReporterOptions {
  outputFile?: string;
  historyFile?: string;
  maxHistoryRuns?: number;
  performanceThreshold?: number;
}

interface TestHistoryEntry {
  passed: boolean;
  duration: number;
  timestamp: string;
}

interface TestHistory {
  [testId: string]: TestHistoryEntry[];
}

interface TestResultData {
  testId: string;
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
  error?: string;
  errorStack?: string;
  retry: number;
  flakinessScore?: number;
  flakinessIndicator?: string;
  performanceTrend?: string;
  averageDuration?: number;
  aiSuggestion?: string;
}

// ============================================================================
// Smart Reporter
// ============================================================================

class SmartReporter implements Reporter {
  private options: Required<SmartReporterOptions>;
  private results: TestResultData[] = [];
  private history: TestHistory = {};
  private startTime: number = 0;
  private outputDir: string = '';

  constructor(options: SmartReporterOptions = {}) {
    this.options = {
      outputFile: options.outputFile ?? 'smart-report.html',
      historyFile: options.historyFile ?? 'test-history.json',
      maxHistoryRuns: options.maxHistoryRuns ?? 10,
      performanceThreshold: options.performanceThreshold ?? 0.2,
    };
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.startTime = Date.now();
    this.outputDir = config.rootDir;
    this.loadHistory();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const testId = this.getTestId(test);
    const file = path.relative(this.outputDir, test.location.file);

    const testData: TestResultData = {
      testId,
      title: test.title,
      file,
      status: result.status,
      duration: result.duration,
      retry: result.retry,
    };

    if (result.status === 'failed' || result.status === 'timedOut') {
      const error = result.errors[0];
      if (error) {
        testData.error = error.message || 'Unknown error';
        testData.errorStack = error.stack;
      }
    }

    // Calculate flakiness
    const historyEntries = this.history[testId] || [];
    if (historyEntries.length > 0) {
      const failures = historyEntries.filter((e) => !e.passed).length;
      const flakinessScore = failures / historyEntries.length;
      testData.flakinessScore = flakinessScore;
      testData.flakinessIndicator = this.getFlakinessIndicator(flakinessScore);

      // Calculate performance trend
      const avgDuration =
        historyEntries.reduce((sum, e) => sum + e.duration, 0) /
        historyEntries.length;
      testData.averageDuration = avgDuration;
      testData.performanceTrend = this.getPerformanceTrend(
        result.duration,
        avgDuration
      );
    } else {
      testData.flakinessIndicator = '⚪ New';
      testData.performanceTrend = '→ Baseline';
    }

    this.results.push(testData);
  }

  async onEnd(result: FullResult): Promise<void> {
    // Get AI suggestions for failures
    await this.addAiSuggestions();

    // Generate HTML report
    const html = this.generateHtml(result);
    const outputPath = path.resolve(this.outputDir, this.options.outputFile);
    fs.writeFileSync(outputPath, html);
    console.log(`\n📊 Smart Report: ${outputPath}`);

    // Update history
    this.updateHistory();
  }

  // ============================================================================
  // History Management
  // ============================================================================

  private loadHistory(): void {
    const historyPath = path.resolve(this.outputDir, this.options.historyFile);
    if (fs.existsSync(historyPath)) {
      try {
        this.history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      } catch {
        this.history = {};
      }
    }
  }

  private updateHistory(): void {
    const timestamp = new Date().toISOString();

    for (const result of this.results) {
      if (!this.history[result.testId]) {
        this.history[result.testId] = [];
      }

      this.history[result.testId].push({
        passed: result.status === 'passed',
        duration: result.duration,
        timestamp,
      });

      // Keep only last N runs
      if (this.history[result.testId].length > this.options.maxHistoryRuns) {
        this.history[result.testId] = this.history[result.testId].slice(
          -this.options.maxHistoryRuns
        );
      }
    }

    const historyPath = path.resolve(this.outputDir, this.options.historyFile);
    fs.writeFileSync(historyPath, JSON.stringify(this.history, null, 2));
  }

  // ============================================================================
  // Flakiness & Performance
  // ============================================================================

  private getTestId(test: TestCase): string {
    const file = path.relative(this.outputDir, test.location.file);
    return `${file}::${test.title}`;
  }

  private getFlakinessIndicator(score: number): string {
    if (score < 0.1) return '🟢 Stable';
    if (score < 0.3) return '🟡 Unstable';
    return '🔴 Flaky';
  }

  private getPerformanceTrend(current: number, average: number): string {
    const diff = (current - average) / average;
    if (diff > this.options.performanceThreshold) {
      return `↑ ${Math.round(diff * 100)}% slower`;
    }
    if (diff < -this.options.performanceThreshold) {
      return `↓ ${Math.round(Math.abs(diff) * 100)}% faster`;
    }
    return '→ Stable';
  }

  // ============================================================================
  // AI Suggestions
  // ============================================================================

  private async addAiSuggestions(): Promise<void> {
    const failedTests = this.results.filter(
      (r) => r.status === 'failed' || r.status === 'timedOut'
    );

    if (failedTests.length === 0) return;

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      console.log(
        '💡 Tip: Set ANTHROPIC_API_KEY or OPENAI_API_KEY for AI failure analysis'
      );
      return;
    }

    console.log(`\n🤖 Analyzing ${failedTests.length} failure(s) with AI...`);

    for (const test of failedTests) {
      try {
        const prompt = this.buildAiPrompt(test);

        if (anthropicKey) {
          test.aiSuggestion = await this.callAnthropic(prompt, anthropicKey);
        } else if (openaiKey) {
          test.aiSuggestion = await this.callOpenAI(prompt, openaiKey);
        }
      } catch (err) {
        console.error(`Failed to get AI suggestion for "${test.title}":`, err);
      }
    }
  }

  private buildAiPrompt(test: TestResultData): string {
    return `Analyze this Playwright test failure and suggest a fix. Be concise (2-3 sentences max).

Test: ${test.title}
File: ${test.file}
Error: ${test.error || 'Unknown error'}

Stack trace:
${test.errorStack || 'No stack trace available'}

Provide a brief, actionable suggestion to fix this failure.`;
  }

  private async callAnthropic(
    prompt: string,
    apiKey: string
  ): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    return data.content[0]?.text || 'No suggestion available';
  }

  private async callOpenAI(prompt: string, apiKey: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || 'No suggestion available';
  }

  // ============================================================================
  // HTML Generation
  // ============================================================================

  private generateHtml(result: FullResult): string {
    const totalDuration = Date.now() - this.startTime;
    const passed = this.results.filter((r) => r.status === 'passed').length;
    const failed = this.results.filter((r) => r.status === 'failed').length;
    const skipped = this.results.filter((r) => r.status === 'skipped').length;
    const flaky = this.results.filter(
      (r) => r.flakinessScore && r.flakinessScore >= 0.3
    ).length;
    const slow = this.results.filter((r) =>
      r.performanceTrend?.startsWith('↑')
    ).length;
    const total = this.results.length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    const testsJson = JSON.stringify(this.results);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Test Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-card: #1a1a24;
      --bg-card-hover: #22222e;
      --border-subtle: #2a2a3a;
      --border-glow: #3b3b4f;
      --text-primary: #f0f0f5;
      --text-secondary: #8888a0;
      --text-muted: #5a5a70;
      --accent-green: #00ff88;
      --accent-green-dim: #00cc6a;
      --accent-red: #ff4466;
      --accent-red-dim: #cc3355;
      --accent-yellow: #ffcc00;
      --accent-yellow-dim: #ccaa00;
      --accent-blue: #00aaff;
      --accent-blue-dim: #0088cc;
      --accent-purple: #aa66ff;
      --accent-orange: #ff8844;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }

    /* Subtle grid background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(var(--border-subtle) 1px, transparent 1px),
        linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
      background-size: 60px 60px;
      opacity: 0.3;
      pointer-events: none;
      z-index: -1;
    }

    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--accent-green) 0%, var(--accent-blue) 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      box-shadow: 0 0 30px rgba(0, 255, 136, 0.2);
    }

    .logo-text h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .logo-text span {
      font-size: 0.875rem;
      color: var(--text-secondary);
      font-family: 'JetBrains Mono', monospace;
    }

    .timestamp {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.875rem;
      color: var(--text-muted);
      background: var(--bg-secondary);
      padding: 0.5rem 1rem;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 900px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
    }

    @media (max-width: 500px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 1.25rem;
      text-align: center;
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--stat-color);
      opacity: 0.8;
    }

    .stat-card:hover {
      transform: translateY(-2px);
      border-color: var(--stat-color);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 20px color-mix(in srgb, var(--stat-color) 20%, transparent);
    }

    .stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2rem;
      font-weight: 700;
      color: var(--stat-color);
      text-shadow: 0 0 20px color-mix(in srgb, var(--stat-color) 40%, transparent);
    }

    .stat-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .stat-card.passed { --stat-color: var(--accent-green); }
    .stat-card.failed { --stat-color: var(--accent-red); }
    .stat-card.skipped { --stat-color: var(--text-muted); }
    .stat-card.flaky { --stat-color: var(--accent-yellow); }
    .stat-card.slow { --stat-color: var(--accent-orange); }
    .stat-card.duration { --stat-color: var(--accent-blue); }

    /* Progress Ring */
    .progress-ring {
      width: 120px;
      height: 120px;
      margin: 0 auto 1.5rem;
      position: relative;
    }

    .progress-ring svg {
      transform: rotate(-90deg);
    }

    .progress-ring circle {
      fill: none;
      stroke-width: 8;
      stroke-linecap: round;
    }

    .progress-ring .bg { stroke: var(--border-subtle); }
    .progress-ring .progress {
      stroke: var(--accent-green);
      stroke-dasharray: 314;
      stroke-dashoffset: calc(314 - (314 * ${passRate}) / 100);
      transition: stroke-dashoffset 1s ease;
      filter: drop-shadow(0 0 8px var(--accent-green));
    }

    .progress-ring .value {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent-green);
    }

    /* Filters */
    .filters {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 1.5rem;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 12px;
      border: 1px solid var(--border-subtle);
    }

    .filter-btn {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-card);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .filter-btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-glow);
      color: var(--text-primary);
    }

    .filter-btn.active {
      background: var(--text-primary);
      color: var(--bg-primary);
      border-color: var(--text-primary);
    }

    /* Test Cards */
    .test-list { display: flex; flex-direction: column; gap: 0.75rem; }

    .test-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .test-card:hover {
      border-color: var(--border-glow);
      background: var(--bg-card-hover);
    }

    .test-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      cursor: pointer;
      gap: 1rem;
    }

    .test-card-left {
      display: flex;
      align-items: center;
      gap: 1rem;
      min-width: 0;
      flex: 1;
    }

    .status-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      animation: pulse 2s infinite;
    }

    .status-indicator.passed {
      background: var(--accent-green);
      box-shadow: 0 0 12px var(--accent-green);
    }

    .status-indicator.failed {
      background: var(--accent-red);
      box-shadow: 0 0 12px var(--accent-red);
      animation: pulse-red 1.5s infinite;
    }

    .status-indicator.skipped {
      background: var(--text-muted);
      box-shadow: none;
      animation: none;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    @keyframes pulse-red {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.8; transform: scale(1.1); }
    }

    .test-info { min-width: 0; flex: 1; }

    .test-title {
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .test-file {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .test-card-right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-shrink: 0;
    }

    .test-duration {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      border: 1px solid;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge.stable {
      color: var(--accent-green);
      border-color: var(--accent-green-dim);
      background: rgba(0, 255, 136, 0.1);
    }

    .badge.unstable {
      color: var(--accent-yellow);
      border-color: var(--accent-yellow-dim);
      background: rgba(255, 204, 0, 0.1);
    }

    .badge.flaky {
      color: var(--accent-red);
      border-color: var(--accent-red-dim);
      background: rgba(255, 68, 102, 0.1);
    }

    .badge.new {
      color: var(--text-muted);
      border-color: var(--border-subtle);
      background: rgba(90, 90, 112, 0.1);
    }

    .trend {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
    }

    .trend.slower { color: var(--accent-orange); }
    .trend.faster { color: var(--accent-green); }
    .trend.stable { color: var(--text-muted); }

    .expand-icon {
      color: var(--text-muted);
      transition: transform 0.2s ease;
      font-size: 0.75rem;
    }

    .test-card.expanded .expand-icon {
      transform: rotate(90deg);
    }

    /* Test Details */
    .test-details {
      display: none;
      padding: 1rem 1.25rem;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
    }

    .test-card.expanded .test-details {
      display: block;
      animation: slideDown 0.2s ease;
    }

    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .detail-section {
      margin-bottom: 1rem;
    }

    .detail-section:last-child {
      margin-bottom: 0;
    }

    .detail-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .detail-label .icon {
      font-size: 1rem;
    }

    .error-box {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      background: rgba(255, 68, 102, 0.1);
      border: 1px solid var(--accent-red-dim);
      border-radius: 8px;
      padding: 1rem;
      color: var(--accent-red);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .stack-box {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      background: var(--bg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 1rem;
      color: var(--text-secondary);
      overflow-x: auto;
      max-height: 200px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .ai-box {
      background: linear-gradient(135deg, rgba(0, 170, 255, 0.1) 0%, rgba(170, 102, 255, 0.1) 100%);
      border: 1px solid var(--accent-blue-dim);
      border-radius: 8px;
      padding: 1rem;
      color: var(--text-primary);
      font-size: 0.9rem;
      position: relative;
    }

    .ai-box::before {
      content: '';
      position: absolute;
      top: -1px;
      left: 20px;
      right: 20px;
      height: 2px;
      background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple));
      border-radius: 2px;
    }

    .duration-compare {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header">
      <div class="logo">
        <div class="logo-icon">S</div>
        <div class="logo-text">
          <h1>Smart Report</h1>
          <span>playwright test insights</span>
        </div>
      </div>
      <div class="timestamp">${new Date().toLocaleString()}</div>
    </header>

    <!-- Progress Ring + Stats -->
    <div style="display: flex; gap: 2rem; align-items: flex-start; margin-bottom: 2rem;">
      <div style="text-align: center;">
        <div class="progress-ring">
          <svg width="120" height="120">
            <circle class="bg" cx="60" cy="60" r="50"/>
            <circle class="progress" cx="60" cy="60" r="50"/>
          </svg>
          <div class="value">${passRate}%</div>
        </div>
        <div style="color: var(--text-secondary); font-size: 0.875rem;">Pass Rate</div>
      </div>

      <div class="stats-grid" style="flex: 1;">
        <div class="stat-card passed">
          <div class="stat-value">${passed}</div>
          <div class="stat-label">Passed</div>
        </div>
        <div class="stat-card failed">
          <div class="stat-value">${failed}</div>
          <div class="stat-label">Failed</div>
        </div>
        <div class="stat-card skipped">
          <div class="stat-value">${skipped}</div>
          <div class="stat-label">Skipped</div>
        </div>
        <div class="stat-card flaky">
          <div class="stat-value">${flaky}</div>
          <div class="stat-label">Flaky</div>
        </div>
        <div class="stat-card slow">
          <div class="stat-value">${slow}</div>
          <div class="stat-label">Slow</div>
        </div>
        <div class="stat-card duration">
          <div class="stat-value">${this.formatDuration(totalDuration)}</div>
          <div class="stat-label">Duration</div>
        </div>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <button class="filter-btn active" data-filter="all" onclick="filterTests('all')">All (${total})</button>
      <button class="filter-btn" data-filter="passed" onclick="filterTests('passed')">Passed (${passed})</button>
      <button class="filter-btn" data-filter="failed" onclick="filterTests('failed')">Failed (${failed})</button>
      <button class="filter-btn" data-filter="skipped" onclick="filterTests('skipped')">Skipped (${skipped})</button>
      <button class="filter-btn" data-filter="flaky" onclick="filterTests('flaky')">Flaky (${flaky})</button>
      <button class="filter-btn" data-filter="slow" onclick="filterTests('slow')">Slow (${slow})</button>
    </div>

    <!-- Test List -->
    <div class="test-list">
      ${this.results.map((test) => this.generateTestCard(test)).join('\n')}
    </div>
  </div>

  <script>
    const tests = ${testsJson};

    function filterTests(filter) {
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });

      document.querySelectorAll('.test-card').forEach(card => {
        const status = card.dataset.status;
        const isFlaky = card.dataset.flaky === 'true';
        const isSlow = card.dataset.slow === 'true';

        let show = filter === 'all' ||
          (filter === 'passed' && status === 'passed') ||
          (filter === 'failed' && (status === 'failed' || status === 'timedOut')) ||
          (filter === 'skipped' && status === 'skipped') ||
          (filter === 'flaky' && isFlaky) ||
          (filter === 'slow' && isSlow);

        card.style.display = show ? 'block' : 'none';
      });
    }

    function toggleDetails(id) {
      const card = document.getElementById('card-' + id);
      card.classList.toggle('expanded');
    }
  </script>
</body>
</html>`;
  }

  private generateTestCard(test: TestResultData): string {
    const isFlaky = test.flakinessScore !== undefined && test.flakinessScore >= 0.3;
    const isUnstable = test.flakinessScore !== undefined && test.flakinessScore >= 0.1 && test.flakinessScore < 0.3;
    const isSlow = test.performanceTrend?.startsWith('↑') || false;
    const isFaster = test.performanceTrend?.startsWith('↓') || false;
    const hasDetails = test.error || test.aiSuggestion || test.status !== 'passed';
    const cardId = this.sanitizeId(test.testId);

    // Determine badge class
    let badgeClass = 'new';
    if (test.flakinessIndicator?.includes('Stable')) badgeClass = 'stable';
    else if (test.flakinessIndicator?.includes('Unstable')) badgeClass = 'unstable';
    else if (test.flakinessIndicator?.includes('Flaky')) badgeClass = 'flaky';

    // Determine trend class
    let trendClass = 'stable';
    if (isSlow) trendClass = 'slower';
    else if (isFaster) trendClass = 'faster';

    return `
      <div id="card-${cardId}" class="test-card"
           data-status="${test.status}"
           data-flaky="${isFlaky}"
           data-slow="${isSlow}">
        <div class="test-card-header" ${hasDetails ? `onclick="toggleDetails('${cardId}')"` : ''}>
          <div class="test-card-left">
            <div class="status-indicator ${test.status === 'passed' ? 'passed' : test.status === 'skipped' ? 'skipped' : 'failed'}"></div>
            <div class="test-info">
              <div class="test-title">${this.escapeHtml(test.title)}</div>
              <div class="test-file">${this.escapeHtml(test.file)}</div>
            </div>
          </div>
          <div class="test-card-right">
            <span class="test-duration">${this.formatDuration(test.duration)}</span>
            ${test.flakinessIndicator ? `<span class="badge ${badgeClass}">${test.flakinessIndicator.replace(/[🟢🟡🔴⚪]\s*/g, '')}</span>` : ''}
            ${test.performanceTrend ? `<span class="trend ${trendClass}">${test.performanceTrend}</span>` : ''}
            ${hasDetails ? `<span class="expand-icon">▶</span>` : ''}
          </div>
        </div>
        ${hasDetails ? this.generateTestDetails(test, cardId) : ''}
      </div>
    `;
  }

  private generateTestDetails(test: TestResultData, cardId: string): string {
    let details = '';

    if (test.error) {
      details += `
        <div class="detail-section">
          <div class="detail-label"><span class="icon">⚠</span> Error</div>
          <div class="error-box">${this.escapeHtml(test.error)}</div>
        </div>
      `;
    }

    if (test.errorStack) {
      details += `
        <div class="detail-section">
          <div class="detail-label"><span class="icon">📋</span> Stack Trace</div>
          <div class="stack-box">${this.escapeHtml(test.errorStack)}</div>
        </div>
      `;
    }

    if (test.aiSuggestion) {
      details += `
        <div class="detail-section">
          <div class="detail-label"><span class="icon">🤖</span> AI Suggestion</div>
          <div class="ai-box">${this.escapeHtml(test.aiSuggestion)}</div>
        </div>
      `;
    }

    if (test.averageDuration !== undefined) {
      details += `
        <div class="duration-compare">
          Average: ${this.formatDuration(test.averageDuration)} → Current: ${this.formatDuration(test.duration)}
        </div>
      `;
    }

    return `<div class="test-details">${details}</div>`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private sanitizeId(str: string): string {
    return str.replace(/[^a-zA-Z0-9]/g, '_');
  }
}

export default SmartReporter;
