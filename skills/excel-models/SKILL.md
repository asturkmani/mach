---
name: excel-models
description: "Building Excel models and simulations in the sandbox that people can open, check and change."
---

Build workbooks with a Python script (openpyxl) kept under code/, so the model can be rebuilt after any change. Put the inputs in a config file (config.yaml or config.json) the script reads.

Layout:
- An Assumptions sheet: one input per row with a label, the value and a unit or note. Style inputs as inputs (blue font), so people know what they may change.
- Calculation sheets that use real formulas referencing the assumption cells (=Assumptions!B3*(1+Assumptions!B4)), never pasted numbers, so changing an input updates the model.
- For simulations (Monte Carlo and similar), run the simulation in Python with a fixed random seed, write the per-run results or a percentile table to a sheet, and say in the Assumptions sheet that the simulated values are static outputs of the script.
- A Summary sheet first, with the handful of numbers people asked for, referencing the other sheets.
- Number formats on every number (0.0%, #,##0, $#,##0.00), sensible column widths, frozen header rows, units in labels ("Revenue ($M)").

Charts: save PNGs with matplotlib (dpi 150, labelled axes, a title, units) in outputs/ and attach them; optionally also add the image to the Summary sheet.

Checks before you attach:
- Run recalc on the file (the attach step also does this) and read it back with openpyxl(data_only=True) to make sure no cell shows an error (#REF!, #DIV/0!, #NAME?) and the key numbers match what your script computed.
- Report the headline numbers from the recalculated file, not from memory.
