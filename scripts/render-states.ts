#!/usr/bin/env bun
// Render captured `omks run` transcripts (states.json) into a single page.
//
// The colours you see are the terminal's own: this converts the captured ANSI
// to spans rather than restyling anything, so the page cannot drift from what
// the CLI prints.
//
//   bun run scripts/capture-states.ts states.json
//   bun run scripts/render-states.ts states.json omks-states.html

interface Scenario {
  id: string;
  title: string;
  eyebrow: string;
  command: string;
  note: string;
  transcript: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ANSI SGR → CSS. The CLI only ever emits these. */
const SGR: Record<string, string> = {
  '1': 'font-weight:600',
  '2': 'opacity:.68',
  '3': 'font-style:italic',
  '31': 'color:var(--err)',
  '32': 'color:var(--ok)',
  '33': 'color:var(--warn)',
  '34': 'color:var(--blue)',
  '35': 'color:var(--brand)',
  '36': 'color:var(--teal)',
  '90': 'color:var(--faint)',
};

/**
 * Convert one ANSI transcript to HTML. Styles accumulate until a reset (0),
 * which is how the CLI's nested `c.bold(c.blue(x))` helpers compose. Segments
 * with no text emit no span — otherwise every reset leaves an empty tag behind.
 */
function ansiToHtml(input: string): string {
  let out = '';
  let styles: string[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out += styles.length ? `<span style="${styles.join(';')}">${esc(buf)}</span>` : esc(buf);
    buf = '';
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    buf += input.slice(last, m.index);
    last = m.index + m[0].length;
    flush();
    for (const code of m[1]!.split(';')) {
      if (code === '0' || code === '') styles = [];
      else if (SGR[code]) styles = [...styles.filter((s) => s !== SGR[code]), SGR[code]!];
    }
  }
  buf += input.slice(last);
  flush();
  return out;
}

const LEGEND: [string, string, string][] = [
  ['❯', 'var(--teal)', 'the goal'],
  ['▸', 'var(--blue)', 'phase'],
  ['›', 'var(--faint)', 'agent started (prefixed by its call id)'],
  ['⚙', 'var(--warn)', 'tool use'],
  ['✱', 'var(--brand)', 'reasoning'],
  ['↻', 'var(--warn)', 'retry'],
  ['↪', 'var(--warn)', 'provider fallback'],
  ['?', 'var(--brand)', 'asking you'],
  ['✓', 'var(--ok)', 'done'],
  ['✗', 'var(--err)', 'failed'],
  ['◼', 'var(--warn)', 'cancelled'],
];

const scenarios: Scenario[] = await Bun.file(process.argv[2] ?? 'states.json').json();

const nav = scenarios
  .map((s) => `<a class="chip" href="#${s.id}" data-for="${s.id}">${esc(s.title.split(' · ')[0]!)}</a>`)
  .join('');

const cards = scenarios
  .map(
    (s) => `
<section class="card" id="${s.id}">
  <header class="card-h">
    <p class="eyebrow">${esc(s.eyebrow)}</p>
    <h2>${esc(s.title)}</h2>
    <p class="note">${s.note}</p>
  </header>
  <figure class="term">
    <figcaption class="bar"><span class="dots"><i></i><i></i><i></i></span><code>${esc(s.command)}</code></figcaption>
    <pre tabindex="0" role="img" aria-label="Terminal transcript: ${esc(s.title)}">${ansiToHtml(s.transcript)}</pre>
  </figure>
</section>`,
  )
  .join('');

const html = `<title>omks run — every state</title>
<style>
  :root{
    --canvas:#0F1115; --panel:#14161C; --line:#262A33;
    --teal:#6DBFB4; --blue:#7AA2D6; --brand:#C792EA;
    --ok:#6FCF97; --warn:#E5C07B; --err:#E06C75; --term-fg:#E4E6EB; --faint:#8B92A0;
    --bg:#F7F8F9; --fg:#15171C; --muted:#5C6270; --hair:#E3E6EA;
    --mono:ui-monospace,"SF Mono",Menlo,"JetBrains Mono",Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  @media (prefers-color-scheme:dark){ :root{ --bg:#0B0C0F; --fg:#E8EAEE; --muted:#98A0AE; --hair:#22262E; } }
  :root[data-theme="dark"]{ --bg:#0B0C0F; --fg:#E8EAEE; --muted:#98A0AE; --hair:#22262E; }
  :root[data-theme="light"]{ --bg:#F7F8F9; --fg:#15171C; --muted:#5C6270; --hair:#E3E6EA; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:56px 24px 96px}
  .mast{display:flex;flex-direction:column;gap:14px;padding-bottom:26px;border-bottom:1px solid var(--hair)}
  .brand{display:flex;align-items:baseline;gap:7px;font-family:var(--mono);font-size:14px}
  .brand .tick{color:var(--teal)}
  .brand b{font-weight:600;letter-spacing:.01em}
  .brand span{color:var(--muted)}
  h1{margin:0;font-size:clamp(28px,4.4vw,42px);line-height:1.12;letter-spacing:-.022em;text-wrap:balance;font-weight:640}
  h1 code{font-family:var(--mono);font-size:.8em;font-weight:600}
  .lede{margin:0;max-width:64ch;color:var(--muted);font-size:17px}
  .legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:4px;font-size:13px;color:var(--muted)}
  .legend div{display:flex;align-items:center;gap:7px;white-space:nowrap}
  .legend b{font-family:var(--mono);font-weight:400;font-size:14px;width:1ch;text-align:center}
  .nav{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;padding:14px 0;margin-bottom:6px;
       background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(8px)}
  .chip{font-family:var(--mono);font-size:12px;text-decoration:none;color:var(--muted);border:1px solid var(--hair);
        border-radius:999px;padding:5px 11px;transition:color .15s,border-color .15s,background .15s}
  .chip:hover{color:var(--fg);border-color:var(--teal)}
  .chip[aria-current="true"]{color:var(--canvas);background:var(--teal);border-color:var(--teal)}
  @media (prefers-color-scheme:dark){ .chip[aria-current="true"]{color:#0B0C0F} }
  a:focus-visible,pre:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:4px}
  .card{padding:34px 0;border-bottom:1px solid var(--hair);scroll-margin-top:66px}
  .card-h{display:flex;flex-direction:column;gap:6px;margin-bottom:18px}
  .eyebrow{margin:0;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--teal)}
  h2{margin:0;font-size:22px;letter-spacing:-.012em;font-weight:620}
  .note{margin:0;max-width:72ch;color:var(--muted);font-size:15px}
  .note code,.foot code{font-family:var(--mono);font-size:.86em;color:var(--fg);background:color-mix(in srgb,var(--teal) 13%,transparent);padding:1px 5px;border-radius:4px}
  .term{margin:0;border-radius:11px;overflow:hidden;background:var(--canvas);border:1px solid var(--line);box-shadow:0 12px 36px -20px rgba(0,0,0,.6)}
  .bar{display:flex;align-items:center;gap:12px;padding:9px 13px;background:var(--panel);border-bottom:1px solid var(--line)}
  .dots{display:flex;gap:6px;flex:none}
  .dots i{width:9px;height:9px;border-radius:50%;background:#2E323C}
  .bar code{font-family:var(--mono);font-size:12px;color:#9BA1AD;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .term pre{margin:0;padding:16px 15px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.62;color:var(--term-fg);white-space:pre}
  .foot{padding-top:32px;color:var(--muted);font-size:14px;max-width:72ch}
  .foot a{color:var(--teal)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style>
<div class="wrap">
  <header class="mast">
    <div class="brand"><span class="tick">▍</span><b>omakase</b><span>· omks</span></div>
    <h1>What <code>omks run</code> actually looks like</h1>
    <p class="lede">Every state a run can end in — captured by running the real engine and the CLI’s own renderer, with only the model scripted so each state is reproducible. The colours are the terminal’s, not a mock-up.</p>
    <div class="legend">${LEGEND.map(([g, col, label]) => `<div><b style="color:${col}">${esc(g)}</b> ${esc(label)}</div>`).join('')}</div>
  </header>
  <nav class="nav" aria-label="States">${nav}</nav>
  ${cards}
  <p class="foot">Agents get a real id (<code>agt_q298tw</code> → <code>q298tw</code>), not a made-up marker — the same id appears in the event log, the JSONL journal and <code>--json</code>, so <code>omks logs &lt;runId&gt; | grep q298tw</code> pulls one agent’s whole story out of an interleaved run. Sequential runs stay quiet: the id only tags child lines once a run has actually gone parallel.<br><br>
  Regenerate this page from the code with <code>bun run scripts/capture-states.ts states.json &amp;&amp; bun run scripts/render-states.ts</code>.</p>
</div>
<script>
  // Light up the chip for the state you're reading.
  const chips = new Map([...document.querySelectorAll('.chip')].map((c) => [c.dataset.for, c]));
  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
    const first = [...document.querySelectorAll('.card')].find((c) => seen.has(c.id));
    for (const [id, chip] of chips) chip.setAttribute('aria-current', String(id === first?.id));
  }, { rootMargin: '-66px 0px -60% 0px' });
  for (const card of document.querySelectorAll('.card')) io.observe(card);
</script>
`;

await Bun.write(process.argv[3] ?? 'omks-states.html', html);
console.log(`rendered ${scenarios.length} scenario(s)`);
