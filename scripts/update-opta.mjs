// Scrapes the Opta Analyst World Cup predictions hub and rewrites opta.json.
// Run by the GitHub Action every 6 hours; fails (without committing) if the page can't be parsed.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";

const HUB = "https://theanalyst.com/competition/fifa-world-cup/predictions";
// Accepted team names (2026 knockout universe). Scraper-side whitelist keeps junk rows out;
// the page itself also ignores names it doesn't know.
const TEAMS = [
  "France","Argentina","Spain","Brazil","England","Portugal","Morocco","Norway","Switzerland",
  "Mexico","USA","United States","Canada","Egypt","Paraguay","Belgium","Colombia","Ghana",
  "Cape Verde","Croatia","Japan","South Korea","Korea Republic","Uzbekistan","Ivory Coast",
  "Turkey","Scotland","Uruguay","Germany","Netherlands","Sweden","Austria","Senegal","Algeria",
  "Ecuador","Australia","Bosnia-Herzegovina","DR Congo","South Africa","Cote d'Ivoire"
];
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z]/g,"");
const CANON = Object.fromEntries(TEAMS.map(t=>[norm(t),t]));
CANON[norm("United States")] = "USA";
CANON[norm("Korea Republic")] = "South Korea";
CANON[norm("Cote d'Ivoire")] = "Ivory Coast";

// Same tolerant parser as the page: team name line (any prefix), numbers on same/following lines,
// only the LAST 5 numbers are used (L16 QF SF FIN CH); reach-% must be non-increasing.
function parseText(txt){
  const rows = {};
  let pending = null;
  const flush = () => {
    if (pending && pending.nums.length >= 4) {
      let v = pending.nums.map(Number);
      v = v.length >= 5 ? v.slice(-5) : [100, ...v];
      const ok = v.every(x => x >= 0 && x <= 100) && v.every((x,i) => i===0 || x <= v[i-1] + 1e-9);
      if (ok) rows[pending.team] = { L16: v[0], QF: v[1], SF: v[2], FIN: v[3], CH: v[4] };
    }
    pending = null;
  };
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/team\s*logo/gi, " ");
    const nums = clean.match(/\d+(?:\.\d+)?/g) || [];
    const nameTxt = clean.replace(/[\d.,%|]+/g, " ").replace(/\s+/g, " ").trim();
    const team = nameTxt ? CANON[norm(nameTxt)] : null;
    if (team) { flush(); pending = { team, nums: [...nums] }; }
    else if (pending) pending.nums.push(...nums);
  }
  flush();
  return rows;
}

// The hub page never goes network-idle (ads, live ticker), so: load DOM only, then poll the
// rendered text until the team table shows up. Falls back to the dataviz widget URL directly.
const URLS = [HUB, "https://dataviz.theanalyst.com/opta-football-predictions/"];

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    viewport: { width: 1400, height: 2200 }
  });
  const page = await ctx.newPage();

  let teams = {}, lastText = "";
  outer:
  for (const url of URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      console.error(`goto failed for ${url}: ${e.message}`);
      continue;
    }
    for (let i = 1; i <= 12; i++) {                 // poll up to ~60 s per URL
      await page.waitForTimeout(5000);
      try { await page.mouse.wheel(0, 1500); } catch {}   // nudge lazy-rendered content
      let text = "";
      for (const frame of page.frames()) {          // page + all iframes (widget lives in one)
        try { text += "\n" + await frame.evaluate(() => document.body ? document.body.innerText : ""); }
        catch { /* cross-origin frame without access — skip */ }
      }
      lastText = text;
      teams = parseText(text);
      console.log(`${url} — poll ${i}: ${Object.keys(teams).length} teams recognised`);
      if (Object.keys(teams).length >= 8) break outer;
    }
  }

  const n = Object.keys(teams).length;
  if (n < 8) {
    console.error(`Only ${n} teams parsed — page layout may have changed. Not updating.`);
    console.error("--- first 3000 chars of scraped text ---\n" + lastText.slice(0, 3000));
    process.exit(1);
  }

  const out = {
    date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          + ", " + new Date().toISOString().slice(11, 16) + " UTC",
    generated_at: new Date().toISOString(),   // lets the page keep a NEWER admin paste over an older feed
    source: HUB,
    teams
  };

  // Skip the commit churn if probabilities are unchanged
  let old = null;
  try { old = JSON.parse(readFileSync("opta.json", "utf8")); } catch {}
  if (old && JSON.stringify(old.teams) === JSON.stringify(out.teams)) {
    console.log(`No change (${n} teams identical). opta.json left untouched.`);
    process.exit(0);
  }

  writeFileSync("opta.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`opta.json updated with ${n} teams:`, Object.keys(teams).join(", "));
} finally {
  await browser.close();
}
