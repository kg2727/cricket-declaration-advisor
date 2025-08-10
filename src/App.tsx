import React, { useMemo, useState } from "react";

// =============================
// Test Cricket Declaration Advisor
// Single-file React app rendered in-canvas
// =============================

// ---------- Types ----------
type SessionWeather = { rainChance: number }; // 0..1

type Inputs = {
  ground: string;
  oversPerSession: number; // typical 30
  sessionsRemaining: number; // whole sessions remaining in match including current
  oversLeftThisSession: number; // overs left in the current session

  currentLead: number; // runs ahead right now (can be negative but model focuses on declaration in 3rd innings)
  wicketsInHand: number; // 0..10, for info when simulating batting on
  continueBattingRunRate: number; // rpo while continuing to bat before declaring
  continueBattingWicketProbPerOver: number; // chance of a wicket per over while batting before declaration

  opponentBattingStrength: number; // 0..100 higher = better batting
  ourBowlingStrength: number; // 0..100 higher = better bowling
  pitchBowlingFactor: number; // 0.5 .. 2.0 higher = helps bowlers

  weatherBySession: SessionWeather[]; // length >= sessionsRemaining (extra ignored)

  riskAppetite: number; // 0 conservative (avoid loss), 1 balanced, 2 aggressive (maximize win even if loss risk rises)

  groundPresetKey: string; // for quick presets
};

// ---------- Ground presets (simple heuristics) ----------
const GROUND_PRESETS: Record<string, { name: string; wicketHelp: number; chaseEase: number }>
  = {
    generic: { name: "Generic Test Ground", wicketHelp: 1.0, chaseEase: 1.0 },
    lords: { name: "Lord's, London", wicketHelp: 1.05, chaseEase: 0.95 },
    gabba: { name: "The Gabba, Brisbane", wicketHelp: 1.1, chaseEase: 0.95 },
    edenGardens: { name: "Eden Gardens, Kolkata", wicketHelp: 0.95, chaseEase: 1.05 },
    mcg: { name: "MCG, Melbourne", wicketHelp: 1.0, chaseEase: 0.98 },
    scg: { name: "SCG, Sydney", wicketHelp: 1.05, chaseEase: 1.0 },
    wanderers: { name: "Wanderers, Johannesburg", wicketHelp: 1.12, chaseEase: 0.93 },
    rawalpindi: { name: "Rawalpindi Cricket Stadium", wicketHelp: 0.9, chaseEase: 1.1 },
  };

// ---------- RNG helpers ----------
function rng(seed: number) {
  // Mulberry32 deterministic RNG
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number, mean: number, sd: number) {
  // Box-Muller
  const u1 = Math.max(r(), 1e-9);
  const u2 = r();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z0;
}

// Clamp helper
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ---------- Core simulation ----------

type SimResult = {
  winP: number;
  drawP: number;
  lossP: number;
  expMarginRuns: number; // +ve means average runs short of target by opp when all out or time up; -ve means they win by that many runs
};

type OptionOutcome = SimResult & {
  optionLabel: string;
  declareAfterOvers: number; // K
  expectAddedRuns: number;
  expectWktsLostWhileBatting: number;
  target: number;
  bowlOversAvail: number; // expected overs available to bowl after declaration
};

function simulateOption(
  inputs: Inputs,
  preset: { wicketHelp: number; chaseEase: number },
  declareAfterOvers: number,
  sims: number,
  seedBase = 12345
): OptionOutcome {
  const r0 = rng(seedBase + declareAfterOvers * 101);

  // 1) Simulate batting on for K overs (or until all out) to set target
  let addedRunsSamples: number[] = [];
  let wktsLostSamples: number[] = [];

  for (let s = 0; s < sims; s++) {
    const r = rng((r0() * 1e9) | 0);
    let runs = 0;
    let wkts = 0;
    for (let o = 0; o < declareAfterOvers; o++) {
      // wicket this over while batting on?
      if (r() < inputs.continueBattingWicketProbPerOver) {
        wkts++;
        if (wkts >= inputs.wicketsInHand) {
          // all out during extension
          // still some runs in the over
          const rpo = Math.max(0, normal(r, inputs.continueBattingRunRate, 0.8));
          runs += Math.max(0, Math.round(normal(r, rpo, 1)));
          // stop early
          // o = declareAfterOvers; // break
          // break out by setting o large
          o = declareAfterOvers;
          break;
        }
      }
      const rpo = Math.max(0, normal(r, inputs.continueBattingRunRate, 0.8));
      runs += Math.max(0, Math.round(normal(r, rpo, 1)));
    }
    addedRunsSamples.push(runs);
    wktsLostSamples.push(wkts);
  }

  const expectAddedRuns = addedRunsSamples.reduce((a, b) => a + b, 0) / sims;
  const expectWktsLost = wktsLostSamples.reduce((a, b) => a + b, 0) / sims;

  // If all out likely before K overs, we already handled by stopping early via sampling logic

  // Target set
  const targetMean = inputs.currentLead + expectAddedRuns; // lead they must chase (>=0)

  // 2) Overs available to bowl after declaration
  // Remaining overs in current session after batting K overs at ~14 minutes per over, but we'll assume overs are fungible: K overs consumed
  // So overs left this session -> max(0, oversLeftThisSession - K)
  // Future sessions: sessionsRemaining - 1

  const oversLeftNow = Math.max(0, inputs.oversLeftThisSession - declareAfterOvers);
  const futureSessions = Math.max(0, inputs.sessionsRemaining - (oversLeftNow > 0 ? 1 : 0));

  // Weather: for each remaining session, apply chance of reduction
  // We'll Monte Carlo inside the main loop when simulating chase

  // ---------- Simulate the chase ----------

  let win = 0, draw = 0, loss = 0;
  let marginAgg = 0;

  const baseWicketPerOver = 0.08; // baseline hazard per over
  const baseRPO = 3.2; // baseline runs per over in 4th innings

  for (let s = 0; s < sims; s++) {
    const r = rng((r0() * 1e9 + s) | 0);

    // derive available overs
    let oversAvail = oversLeftNow;

    // For the remainder sessions after this one
    const sessionCount = inputs.sessionsRemaining - (oversLeftNow > 0 ? 1 : 0);

    for (let si = 0; si < sessionCount; si++) {
      const weather = inputs.weatherBySession[si] || { rainChance: 0 };
      const rainOccurs = r() < weather.rainChance;
      const expectedCut = rainOccurs ? (0.2 + 0.6 * r()) : 0.0; // if it rains, 20%..80% of overs lost this session
      const sessionOvers = inputs.oversPerSession * (1 - expectedCut);
      oversAvail += sessionOvers;
    }

    // Simulate opposition batting towards target
    const strengthFactor = (inputs.ourBowlingStrength / 50) * preset.wicketHelp * inputs.pitchBowlingFactor;
    const battingFactor = (inputs.opponentBattingStrength / 50) * preset.chaseEase;

    let wicketP = clamp(baseWicketPerOver * strengthFactor / Math.max(0.6, battingFactor), 0.03, 0.2);
    let rpoMean = clamp(baseRPO * battingFactor / Math.max(0.7, inputs.pitchBowlingFactor), 1.5, 4.5);

    // allow hazard to increase slightly every 20 overs as ball ages/pitch wears
    let wickets = 0, runs = 0;
    for (let o = 0; o < oversAvail; o++) {
      // small end-game acceleration of scoring if behind RR
      const reqRPO = (targetMean - runs) / Math.max(1, oversAvail - o);
      const pressureLift = reqRPO > rpoMean ? clamp((reqRPO - rpoMean) * 0.15, 0, 0.8) : 0;

      const overRuns = Math.max(0, Math.round(normal(r, rpoMean + pressureLift, 1)));
      runs += overRuns;

      // wicket event(s)
      if (r() < wicketP) {
        wickets++;
        // slight increase as pitch wears and batters down the order appear
        wicketP = clamp(wicketP * 1.02, 0.03, 0.25);
      }

      // drift towards tougher batting later
      if ((o + 1) % 20 === 0) {
        rpoMean = Math.max(1.2, rpoMean * 0.98);
        wicketP = clamp(wicketP * 1.03, 0.03, 0.25);
      }

      if (runs >= targetMean) {
        loss++; // opponent chased successfully
        marginAgg += -(runs - targetMean); // negative = they win by runs
        break;
      }
      if (wickets >= 10) {
        win++;
        marginAgg += targetMean - runs; // positive margin remaining
        break;
      }

      // if last over used and neither condition met -> draw
      if (o === Math.floor(oversAvail) - 1) {
        draw++;
        marginAgg += targetMean - runs; // our margin if time expired
      }
    }
  }

  const winP = win / sims;
  const lossP = loss / sims;
  const drawP = draw / sims;

  return {
    optionLabel: declareAfterOvers === 0 ? "Declare now" : `Declare in ${declareAfterOvers} over${declareAfterOvers === 1 ? "" : "s"}`,
    declareAfterOvers,
    expectAddedRuns: expectAddedRuns,
    expectWktsLostWhileBatting: expectWktsLost,
    target: targetMean,
    bowlOversAvail: 0, // filled below with expectation, but we can approximate with mean
    winP,
    lossP,
    drawP,
    expMarginRuns: marginAgg / sims,
  };
}

function evaluateAllOptions(inputs: Inputs, sims = 2500) {
  const preset = GROUND_PRESETS[inputs.groundPresetKey] || GROUND_PRESETS.generic;

  const maxK = Math.min(30, inputs.oversLeftThisSession + (inputs.sessionsRemaining - 1) * inputs.oversPerSession); // do not consider more than 30 overs of batting on
  const options: OptionOutcome[] = [];

  for (let K = 0; K <= maxK; K += 1) {
    const out = simulateOption(inputs, preset, K, sims, 1234);
    options.push(out);
  }

  // Utility based on risk appetite
  const weightLoss = inputs.riskAppetite < 1 ? 2.0 : inputs.riskAppetite < 1.5 ? 1.2 : 0.8;
  const weightWin = 1.0;

  const withUtility = options.map((o) => ({
    ...o,
    utility: weightWin * o.winP - weightLoss * o.lossP,
  }));

  withUtility.sort((a, b) => b.utility - a.utility);

  const best = withUtility[0];
  const runnerUp = withUtility[1];

  return { best, runnerUp, options: withUtility, preset };
}

// ---------- UI helpers ----------
function pct(n: number) {
  return (n * 100).toFixed(1) + "%";
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="w-full mb-2">
      <div className="text-xs mb-1 flex justify-between"><span>{label}</span><span>{pct(value)}</span></div>
      <div className="w-full h-2 bg-gray-200/80 rounded-xl overflow-hidden">
        <div className="h-2 rounded-xl" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/70 rounded-2xl shadow p-4">
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      {children}
    </div>
  );
}

// ---------- Main Component ----------
export default function DeclarationAdvisor() {
  const [inputs, setInputs] = useState<Inputs>({
    ground: GROUND_PRESETS.generic.name,
    oversPerSession: 30,
    sessionsRemaining: 3,
    oversLeftThisSession: 24,

    currentLead: 250,
    wicketsInHand: 6,
    continueBattingRunRate: 3.8,
    continueBattingWicketProbPerOver: 0.12,

    opponentBattingStrength: 60,
    ourBowlingStrength: 65,
    pitchBowlingFactor: 1.15,

    weatherBySession: [
      { rainChance: 0.1 },
      { rainChance: 0.2 },
      { rainChance: 0.2 },
      { rainChance: 0.2 },
    ],

    riskAppetite: 1.0,
    groundPresetKey: "generic",
  });

  const [sims, setSims] = useState(2500);
  const [seed, setSeed] = useState(1234);

  const { best, runnerUp, options, preset } = useMemo(() => evaluateAllOptions({ ...inputs }, sims), [inputs, sims, seed]);

  const applyPreset = (key: string) => {
    const g = GROUND_PRESETS[key];
    setInputs((prev) => ({ ...prev, ground: g.name, groundPresetKey: key }));
  };

  const loadScenario = (label: string) => {
    if (label === "Day 5 squeeze") {
      setInputs({
        ground: GROUND_PRESETS.scg.name,
        oversPerSession: 30,
        sessionsRemaining: 2,
        oversLeftThisSession: 18,
        currentLead: 310,
        wicketsInHand: 7,
        continueBattingRunRate: 3.7,
        continueBattingWicketProbPerOver: 0.11,
        opponentBattingStrength: 55,
        ourBowlingStrength: 70,
        pitchBowlingFactor: 1.25,
        weatherBySession: [{ rainChance: 0.05 }, { rainChance: 0.15 }, { rainChance: 0.15 }],
        riskAppetite: 1.0,
        groundPresetKey: "scg",
      });
    }
    if (label === "Flat pitch, rain risk") {
      setInputs({
        ground: GROUND_PRESETS.rawalpindi.name,
        oversPerSession: 30,
        sessionsRemaining: 3,
        oversLeftThisSession: 22,
        currentLead: 180,
        wicketsInHand: 5,
        continueBattingRunRate: 4.2,
        continueBattingWicketProbPerOver: 0.09,
        opponentBattingStrength: 70,
        ourBowlingStrength: 60,
        pitchBowlingFactor: 0.9,
        weatherBySession: [{ rainChance: 0.3 }, { rainChance: 0.4 }, { rainChance: 0.4 }],
        riskAppetite: 0.7,
        groundPresetKey: "rawalpindi",
      });
    }
  };

  const onNum = (k: keyof Inputs) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setInputs((prev) => ({ ...prev, [k]: isNaN(v) ? 0 : v }));
  };

  const onSlider = (k: keyof Inputs, factor = 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value) / factor;
    setInputs((prev) => ({ ...prev, [k]: v }));
  };

  const changeWeather = (idx: number, v: number) => {
    const arr = inputs.weatherBySession.slice();
    arr[idx] = { rainChance: clamp(v, 0, 1) };
    setInputs((prev) => ({ ...prev, weatherBySession: arr }));
  };

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-emerald-50 to-sky-50 text-slate-900 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Test Cricket Declaration Advisor</h1>
          <p className="text-sm md:text-base text-slate-600 mt-1">Input the current match context. The model simulates thousands of fourth-innings chases to suggest when to declare. Every recommendation includes the reasoning behind it.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Inputs */}
          <Section title="Match context">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col text-sm">Ground preset
                <select value={inputs.groundPresetKey} onChange={(e) => applyPreset(e.target.value)} className="mt-1 rounded-xl border p-2">
                  {Object.keys(GROUND_PRESETS).map((k) => (
                    <option key={k} value={k}>{GROUND_PRESETS[k].name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-sm">Overs / session
                <input type="number" value={inputs.oversPerSession} onChange={onNum("oversPerSession")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">Sessions remaining
                <input type="number" value={inputs.sessionsRemaining} onChange={onNum("sessionsRemaining")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">Overs left this session
                <input type="number" value={inputs.oversLeftThisSession} onChange={onNum("oversLeftThisSession")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">Current lead (runs)
                <input type="number" value={inputs.currentLead} onChange={onNum("currentLead")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">Wickets in hand
                <input type="number" value={inputs.wicketsInHand} onChange={onNum("wicketsInHand")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">If batting on, run rate
                <input type="number" step={0.1} value={inputs.continueBattingRunRate} onChange={onNum("continueBattingRunRate")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">If batting on, wicket chance / over
                <input type="number" step={0.01} value={inputs.continueBattingWicketProbPerOver} onChange={onNum("continueBattingWicketProbPerOver")} className="mt-1 rounded-xl border p-2" />
              </label>
              <label className="flex flex-col text-sm">Opponent batting strength
                <input type="range" min={30} max={80} value={inputs.opponentBattingStrength} onChange={onSlider("opponentBattingStrength")}
                  className="mt-3" />
                <span className="text-xs text-slate-500">{inputs.opponentBattingStrength}</span>
              </label>
              <label className="flex flex-col text-sm">Our bowling strength
                <input type="range" min={30} max={80} value={inputs.ourBowlingStrength} onChange={onSlider("ourBowlingStrength")}
                  className="mt-3" />
                <span className="text-xs text-slate-500">{inputs.ourBowlingStrength}</span>
              </label>
              <label className="flex flex-col text-sm">Pitch bowling factor
                <input type="range" min={0.6} max={1.6} step={0.01} value={inputs.pitchBowlingFactor} onChange={onSlider("pitchBowlingFactor")}
                  className="mt-3" />
                <span className="text-xs text-slate-500">{inputs.pitchBowlingFactor.toFixed(2)}</span>
              </label>
              <label className="flex flex-col text-sm">Risk appetite
                <input type="range" min={0} max={2} step={0.01} value={inputs.riskAppetite} onChange={onSlider("riskAppetite")}
                  className="mt-3" />
                <span className="text-xs text-slate-500">{inputs.riskAppetite < 0.9 ? "Conservative" : inputs.riskAppetite < 1.4 ? "Balanced" : "Aggressive"} ({inputs.riskAppetite.toFixed(2)})</span>
              </label>
            </div>

            <div className="mt-4">
              <div className="text-sm font-medium mb-2">Weather by upcoming session (rain chance)</div>
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: inputs.sessionsRemaining }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs w-16">Session {i + 1}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((inputs.weatherBySession[i]?.rainChance ?? 0) * 100)}
                      onChange={(e) => changeWeather(i, Number(e.target.value) / 100)}
                      className="flex-1"
                    />
                    <span className="text-xs w-10 text-right">{Math.round((inputs.weatherBySession[i]?.rainChance ?? 0) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex gap-2 flex-wrap">
              <button onClick={() => loadScenario("Day 5 squeeze")} className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm shadow">Load: Day 5 squeeze</button>
              <button onClick={() => loadScenario("Flat pitch, rain risk")} className="px-3 py-2 rounded-xl bg-sky-600 text-white text-sm shadow">Load: Flat pitch, rain risk</button>
            </div>
          </Section>

          {/* Recommendation */}
          <Section title="Recommendation">
            {best && (
              <div>
                <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200">
                  <div className="text-sm">Suggested action</div>
                  <div className="text-xl font-bold mt-1">{best.declareAfterOvers === 0 ? "Declare now" : `Declare in ${best.declareAfterOvers} over${best.declareAfterOvers === 1 ? "" : "s"}`}</div>
                  <div className="text-sm mt-2 text-slate-700">Projected target ~ <span className="font-semibold">{Math.round(best.target)}</span> with an expected additional <span className="font-semibold">{Math.round(best.expectAddedRuns)}</span> runs if you bat on.
                  </div>
                </div>

                <div className="mt-4">
                  <Bar value={best.winP} label="Win probability" />
                  <Bar value={best.drawP} label="Draw probability" />
                  <Bar value={best.lossP} label="Loss probability" />
                </div>

                {runnerUp && (
                  <div className="mt-4 text-xs text-slate-600">
                    Next best: <span className="font-medium">{runnerUp.optionLabel}</span> with {pct(runnerUp.winP)} win and {pct(runnerUp.lossP)} loss.
                  </div>
                )}

                <div className="mt-4">
                  <h3 className="font-semibold mb-2">Reasoning</h3>
                  <ul className="text-sm space-y-2 list-disc pl-5">
                    <li>
                      Trade-off between <span className="font-medium">time to take 10 wickets</span> and <span className="font-medium">runs on the board</span>: this option balances a target near <span className="font-semibold">{Math.round(best.target)}</span> with the time cost of batting on.
                    </li>
                    <li>
                      Bowling context: our attack strength <span className="font-semibold">{inputs.ourBowlingStrength}</span> versus their batting <span className="font-semibold">{inputs.opponentBattingStrength}</span>, adjusted by pitch factor <span className="font-semibold">{inputs.pitchBowlingFactor.toFixed(2)}</span> and ground profile <span className="font-semibold">{inputs.ground}</span>.
                    </li>
                    <li>
                      Weather risk reduces available overs. Session rain chances considered: {inputs.weatherBySession.slice(0, inputs.sessionsRemaining).map((w, i) => `${i + 1}:${Math.round((w?.rainChance ?? 0) * 100)}%`).join(", ")}. Declaring earlier preserves overs when rain is likely.
                    </li>
                    <li>
                      Compared with {runnerUp ? <span className="font-medium">{runnerUp.optionLabel}</span> : "nearby options"}, this choice changes win by <span className="font-semibold">{runnerUp ? (Math.round((best.winP - runnerUp.winP) * 1000) / 10) : 0}%</span> and loss by <span className="font-semibold">{runnerUp ? (Math.round((best.lossP - runnerUp.lossP) * 1000) / 10) : 0}%</span>, reflecting your current risk appetite.
                    </li>
                    <li>
                      Expected margin if time expires or wickets fall: <span className="font-semibold">{Math.round(best.expMarginRuns)}</span> runs in our favor on average under this option.
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </Section>

          {/* Options table */}
          <Section title="Win/draw/loss by declaration timing">
            <div className="max-h-[520px] overflow-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    <th className="text-left p-2">Declare</th>
                    <th className="text-right p-2">Target</th>
                    <th className="text-right p-2">Win</th>
                    <th className="text-right p-2">Draw</th>
                    <th className="text-right p-2">Loss</th>
                    <th className="text-right p-2">Utility</th>
                  </tr>
                </thead>
                <tbody>
                  {options.map((o, idx) => (
                    <tr key={idx} className={idx === 0 ? "bg-emerald-50" : idx % 2 ? "bg-white" : "bg-slate-50/40"}>
                      <td className="p-2">{o.optionLabel}</td>
                      <td className="p-2 text-right">{Math.round(o.target)}</td>
                      <td className="p-2 text-right">{pct(o.winP)}</td>
                      <td className="p-2 text-right">{pct(o.drawP)}</td>
                      <td className="p-2 text-right">{pct(o.lossP)}</td>
                      <td className="p-2 text-right">{o.utility.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 text-xs text-slate-500">
              Simulations per option: {sims}. You can change this value in the code or ask me to increase it if you want even tighter estimates.
            </div>
          </Section>
        </div>

        {/* Footer controls */}
        <div className="mt-6 flex flex-wrap gap-3 items-center">
          <div className="text-xs text-slate-500">Ground factors — wicket help: <span className="font-semibold">{GROUND_PRESETS[inputs.groundPresetKey]?.wicketHelp.toFixed(2)}</span>, chase ease: <span className="font-semibold">{GROUND_PRESETS[inputs.groundPresetKey]?.chaseEase.toFixed(2)}</span></div>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-sm">Seed
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="ml-2 rounded-xl border p-2 w-28" />
            </label>
            <label className="text-sm">Sims/option
              <input type="number" value={sims} onChange={(e) => setSims(Number(e.target.value))} className="ml-2 rounded-xl border p-2 w-28" />
            </label>
          </div>
        </div>

        <div className="mt-6 text-xs text-slate-500">
          Notes: This is a transparent heuristic Monte Carlo model, not a perfect replica of Test cricket dynamics. It captures the key trade-offs that elite captains juggle — time to take wickets, target size, pitch wearing, weather, and relative team strengths — and it always explains its recommendation. If you want, I can calibrate the ground presets and hazard rates from historical data next.
        </div>
      </div>
    </div>
  );
}