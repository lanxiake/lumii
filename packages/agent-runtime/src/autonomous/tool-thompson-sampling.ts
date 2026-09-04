/**
 * P2: Thompson Sampling for Tool Selection
 *
 * 使用 Beta 分布建模工具成功率的不确定性
 * 来源：设计文档 2026-09-04-autonomous-evolution-agent-implementation-p2.md
 */

import type { ToolSelectionStats } from './types';
import { THOMPSON_SAMPLING_MAX_ITERATIONS } from './config';

/**
 * Thompson Sampling 工具选择算法
 */
export class ToolThompsonSampling {
  private stats: Map<string, ToolSelectionStats>;
  private maxIterations: number;

  constructor(maxIterations: number = THOMPSON_SAMPLING_MAX_ITERATIONS) {
    this.stats = new Map();
    this.maxIterations = maxIterations;
  }

  /**
   * 初始化工具统计（Beta(1, 1) = 均匀先验）
   */
  initTool(toolName: string): void {
    if (!this.stats.has(toolName)) {
      this.stats.set(toolName, {
        toolName,
        alpha: 1,
        beta: 1,
        totalUsage: 0,
        lastUsed: new Date().toISOString(),
      });
    }
  }

  /**
   * 选择工具（Thompson Sampling）
   */
  selectTool(availableTools: string[]): string {
    if (availableTools.length === 0) {
      throw new Error('No available tools to select from');
    }

    if (availableTools.length === 1) {
      return availableTools[0];
    }

    // 确保所有工具都已初始化
    availableTools.forEach((tool) => this.initTool(tool));

    // 从每个工具的 Beta 分布中采样
    let bestTool: string = availableTools[0];
    let bestSample = -Infinity;

    for (const tool of availableTools) {
      const stat = this.stats.get(tool)!;
      const sample = this.sampleBeta(stat.alpha, stat.beta);

      if (sample > bestSample) {
        bestSample = sample;
        bestTool = tool;
      }
    }

    return bestTool;
  }

  /**
   * 更新工具统计
   */
  updateStats(toolName: string, success: boolean): void {
    const stat = this.stats.get(toolName);
    if (!stat) {
      this.initTool(toolName);
      return this.updateStats(toolName, success);
    }

    if (success) {
      stat.alpha += 1;
    } else {
      stat.beta += 1;
    }
    stat.totalUsage += 1;
    stat.lastUsed = new Date().toISOString();
  }

  /**
   * 从 Beta 分布采样
   * 使用 Gamma 分布近似: Beta(α, β) = Gamma(α, 1) / (Gamma(α, 1) + Gamma(β, 1))
   */
  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }

  /**
   * 从 Gamma 分布采样（使用 Marsaglia-Tsang 方法）
   */
  private sampleGamma(shape: number, scale: number): number {
    if (shape < 1) {
      return this.sampleGamma(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    for (let i = 0; i < this.maxIterations; i++) {
      let x: number, v: number;
      do {
        x = this.sampleNormal(0, 1);
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      // 快速接受
      if (u < 1 - 0.0331 * x * x * x * x) {
        return d * v * scale;
      }

      // 慢速接受
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v * scale;
      }
    }

    // 达到最大迭代次数，返回期望值作为 fallback
    return shape * scale;
  }

  /**
   * 从标准正态分布采样（Box-Muller 变换）
   */
  private sampleNormal(mean: number, stddev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + stddev * z;
  }

  /**
   * 获取工具成功率估计
   */
  getSuccessRateEstimate(toolName: string): {
    mean: number;
    credibleInterval: [number, number];
  } {
    const stat = this.stats.get(toolName);
    if (!stat) {
      return { mean: 0.5, credibleInterval: [0, 1] };
    }

    const mean = stat.alpha / (stat.alpha + stat.beta);

    // 95% 可信区间（使用 Beta 分布的分位数近似）
    const lower = this.betaQuantile(stat.alpha, stat.beta, 0.025);
    const upper = this.betaQuantile(stat.alpha, stat.beta, 0.975);

    return { mean, credibleInterval: [lower, upper] };
  }

  /**
   * Beta 分布分位数（简化近似）
   */
  private betaQuantile(alpha: number, beta: number, p: number): number {
    // 使用正态近似（当 alpha, beta > 5 时较准确）
    if (alpha > 5 && beta > 5) {
      const mean = alpha / (alpha + beta);
      const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
      const z = this.normalQuantile(p);
      return Math.max(0, Math.min(1, mean + z * Math.sqrt(variance)));
    }

    // 对于小样本，使用简单的分位数估计
    if (p <= 0.025) return Math.max(0, (alpha - 1) / (alpha + beta + 2));
    if (p >= 0.975) return Math.min(1, (alpha + 1) / (alpha + beta + 2));
    return alpha / (alpha + beta);
  }

  /**
   * 标准正态分布分位数（近似）
   */
  private normalQuantile(p: number): number {
    // Beasley-Springer-Moro 算法简化版
    if (p === 0.5) return 0;
    if (p < 0.5) return -this.normalQuantile(1 - p);

    const a0 = 2.50662823884;
    const a1 = -18.61500062529;
    const a2 = 41.39119773534;
    const a3 = -25.44106049637;
    const b1 = -8.4735109309;
    const b2 = 23.08336743743;
    const b3 = -21.06224101826;
    const b4 = 3.13082909833;

    const y = p - 0.5;
    const r = y * y;

    return (y * (((a3 * r + a2) * r + a1) * r + a0)) / ((((b4 * r + b3) * r + b2) * r + b1) * r + 1);
  }

  /**
   * 获取所有工具统计
   */
  getAllStats(): ToolSelectionStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * 获取单个工具统计
   */
  getStats(toolName: string): ToolSelectionStats | undefined {
    return this.stats.get(toolName);
  }

  /**
   * 加载统计数据（用于持久化恢复）
   */
  loadStats(stats: ToolSelectionStats[]): void {
    this.stats.clear();
    for (const stat of stats) {
      this.stats.set(stat.toolName, { ...stat });
    }
  }
}
