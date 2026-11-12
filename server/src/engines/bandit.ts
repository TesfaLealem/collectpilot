// UCB1 multi-armed bandit over tone x channel x send-window, learned per customer segment.
export const TONES = ['friendly', 'neutral', 'firm'] as const;
export const CHANNELS = ['email', 'telegram'] as const;
export const WINDOWS = ['morning', 'midday', 'afternoon'] as const;
export const WINDOW_HOURS: Record<string, [number, number]> = { morning: [8, 11], midday: [11, 14], afternoon: [14, 18] };

export interface Arm { tone: string; channel: string; window: string; pulls: number; rewards: number }
export const armKey = (a: { tone: string; channel: string; window: string }) => `${a.tone}|${a.channel}|${a.window}`;

export function allArms(): Arm[] {
  const out: Arm[] = [];
  for (const tone of TONES) for (const channel of CHANNELS) for (const window of WINDOWS) out.push({ tone, channel, window, pulls: 0, rewards: 0 });
  return out;
}

/** Policy guard on exploration: tone is limited by how overdue the account is. */
export function allowedTones(daysPastDue: number): string[] {
  if (daysPastDue <= 0) return ['friendly'];
  if (daysPastDue < 15) return ['friendly', 'neutral'];
  return ['friendly', 'neutral', 'firm'];
}

export interface Selection { arm: Arm; ucb: number; mean: number; explored: boolean; reason: string; candidates: { key: string; mean: number; ucb: number; pulls: number }[] }

export function selectArm(stats: Arm[], opts: { tones: string[]; channels: string[]; defaultTone: string; preferredChannel: string }): Selection {
  const merged = allArms().map((a) => stats.find((s) => armKey(s) === armKey(a)) ?? a)
    .filter((a) => opts.tones.includes(a.tone) && opts.channels.includes(a.channel));
  if (!merged.length) throw new Error('No allowed arm');
  const total = merged.reduce((s, a) => s + a.pulls, 0);
  const scored = merged.map((a) => {
    const mean = a.pulls ? a.rewards / a.pulls : 0;
    const ucb = a.pulls ? mean + Math.sqrt((2 * Math.log(Math.max(total, 2))) / a.pulls) : Infinity;
    // Tie-break toward the safe default (segment tone, customer's preferred channel, morning).
    const prior = (a.tone === opts.defaultTone ? 0.002 : 0) + (a.channel === opts.preferredChannel ? 0.002 : 0) + (a.window === 'morning' ? 0.001 : 0);
    return { a, mean, ucb, prior };
  }).sort((x, y) => (y.ucb === x.ucb ? y.prior - x.prior : y.ucb - x.ucb));
  const top = scored[0];
  const explored = top.a.pulls === 0 || top.mean < Math.max(...scored.map((s) => s.mean));
  return {
    arm: top.a, ucb: top.ucb, mean: top.mean, explored,
    reason: top.a.pulls === 0
      ? `Trying an untested approach (${armKey(top.a)}) for this segment`
      : explored
        ? `Exploring ${armKey(top.a)}: uncertain but promising (success ${(top.mean * 100).toFixed(0)}% over ${top.a.pulls} tries)`
        : `Using the best-known approach ${armKey(top.a)} (success ${(top.mean * 100).toFixed(0)}% over ${top.a.pulls} tries)`,
    candidates: scored.slice(0, 5).map((s) => ({ key: armKey(s.a), mean: Math.round(s.mean * 100) / 100, ucb: s.ucb === Infinity ? 99 : Math.round(s.ucb * 100) / 100, pulls: s.a.pulls })),
  };
}
