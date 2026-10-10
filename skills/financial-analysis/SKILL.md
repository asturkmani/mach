---
name: financial-analysis
description: "Reviewing a company's earnings and building a simple projection model with stated assumptions."
---

Earnings review:
- Find the latest reported quarter: the earnings release, the 10-Q or 10-K, and the guidance for the next quarter. Note the fiscal calendar; many companies' fiscal quarters don't match calendar quarters.
- Report revenue, gross margin, operating income, net income and EPS (GAAP and non-GAAP if both are given), each with the year-on-year and quarter-on-quarter change.
- Add segment or product revenue, key KPIs, cash flow, capex and net cash or debt.
- Compare results and guidance with consensus when you can find it, and say what drove the quarter.

Projection model:
- Build quarterly columns: the last two to four reported quarters, then the projected quarters, clearly marked as estimates (for example "FQ1 2027E").
- Rows: revenue (by segment if it matters), gross margin %, gross profit, operating expenses, operating income, operating margin %, tax rate, net income, diluted shares, EPS.
- Drive the projections from a few explicit assumptions listed at the top or bottom: revenue growth per quarter, margins, opex growth, tax rate, share count. Anchor the first projected quarter to company guidance.
- Build the model in your sandbox as an xlsx (load the excel-models skill): assumptions as input cells, the model as formulas that reference them, and the script that builds it kept under code/ so it can be rebuilt. Attach it with attach_file.
- In your report, give the headline numbers, the key assumptions and the main risks in a few sentences. The full table belongs in the file.
