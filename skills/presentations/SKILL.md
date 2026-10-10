---
name: presentations
description: "Making a slide deck (.pptx) from analysis or a model's numbers: the story, one point per slide, charts drawn from the data, and checking it before it goes out."
---

A deck is for someone who will flick through it in a few minutes, often on a phone. It makes a point; it doesn't hold everything you found.

1. The story first
- Write the headline of every slide before building any: one sentence each that says what the slide shows ("Base case 2027E EPS is $14.20, 18% above consensus"), not its topic ("EPS").
- Open with the answer (one slide), then the evidence, then the risks and what would change the view. Six to twelve slides; anything longer goes in an appendix.

2. Numbers come from files, never from your head
- Read every figure from the model or data file the job made (load excel-models for models). If a number isn't in a file, compute it with code first.
- Charts are drawn from those files with matplotlib (or the data in a native chart), saved as PNGs at 2x, and placed on the slide. Label axes and units; say the date of the data.
- Keep a small table of every number on the slides and the file and cell it came from (in NOTES.md), so a change to the model can be carried into the deck.

3. Build it with python-pptx (it's in the sandbox)
- 16:9, one idea per slide: the headline as the title, then a chart, a table or three short bullets at most. No paragraphs.
- If the company has a template (a .pptx in the job's inputs, or one named in a company skill that extends this one), build on its layouts and fonts; otherwise plain: white background, one accent colour, a sans-serif font.
- Put the sources and the as-of date in small text at the bottom of the slides that use them.

4. Check before attaching
- Render every slide to an image (LibreOffice: `soffice --headless --convert-to pdf`, then look at the pages) and look for overflowing text, clipped charts and empty slides.
- Check that every number on the slides matches its source file.
- Attach the .pptx with attach_file (and the PDF, so it previews), and report the headline answer in a sentence or two.
