# Expert runs (Claude Sonnet)

Generated from `groupings.json` by `node scripts/experiments/grading-two-sets.mjs expert-runs`; do not edit by hand.
The expert grades the same requests as Gemini, in the same order, with the same groupings and positions.
The expert's first one-at-a-time pass (step `solo`) is the answer key; the other steps measure the expert's own consistency and batch effect.

## Rules

- Each request below is graded in a fresh context (a new Sonnet agent) that has seen no other request and no earlier answer.
  A repeat must not know it is a repeat, or the consistency numbers mean nothing.
- Read only these files: `experiments/grading-two-sets/expert-instructions.txt`, `expert-batch-instructions.txt`, `rubric.txt`, this file, and the four files of each bundle named in the request (`desktop.jpg`, `phone.jpg`, `text.txt`, `facts.json`).
- Never open: `experiments/grading-two-sets/prompts/`, `prompt-log.md`, `sites.json`, `lock.json`, anything under `~/research/portfoliorank-experiments/grading-two-sets` other than `bundles/` and your own `expert/` folder (never `gemini/`, `raw/`, `capture/`, `selection.json` or `analysis.json`), the old `grading-v3` data, the database, or any website.
  Those hold check points, Gemini's prompt or Gemini's answers.
- The prompt for a one-at-a-time request is `expert-instructions.txt` with the line `[rubric: the three parts and their five levels, exactly as shown above]` replaced by the full text of `rubric.txt`.
  The prompt for a 5-at-a-time request is `expert-batch-instructions.txt`, with the same replacement, and the 5 bundles in the order listed.
- Never redo a request whose output file exists, and never edit an output after writing it.

## Output

One JSON file per request, at the path given, in this shape (one entry in `answers` per bundle id; `evidence` is the one-line reason; `tips` may be empty strings):

```json
{
 "step": "solo",
 "set": "A",
 "kind": "solo",
 "ids": [
  "A01"
 ],
 "started_at": "2026-11-13T19:00:00Z",
 "finished_at": "2026-11-13T19:01:00Z",
 "answers": {
  "A01": {
   "five_second": {
    "name": {
     "seen": "quoted words, or nothing",
     "desktop": true,
     "phone": true
    },
    "clear_role": {
     "seen": "quoted words, or nothing",
     "desktop": true,
     "phone": true
    },
    "way_forward": {
     "seen": "quoted words, or nothing",
     "desktop": true,
     "phone": true
    },
    "notable": {
     "seen": "quoted words, or nothing",
     "desktop": true,
     "phone": true
    }
   },
   "visual_design": {
    "evidence": "what you saw",
    "level_line": "the level line that fits",
    "score": 3
   },
   "project_presentation": {
    "evidence": "...",
    "level_line": "...",
    "score": 3
   },
   "writing": {
    "evidence": "...",
    "level_line": "...",
    "score": 3
   },
   "is_portfolio": {
    "reason": "...",
    "answer": true
   },
   "tips": {
    "visual_design": "",
    "project_presentation": "",
    "writing": ""
   }
  }
 }
}
```

For a 5-at-a-time request, `kind` is `batch`, `ids` lists the 5 bundle ids in the order shown, and `answers` has all 5.

## Requests, in order

Bundles live in `~/research/portfoliorank-experiments/grading-two-sets/bundles/<set>/<id>/`; outputs go in `~/research/portfoliorank-experiments/grading-two-sets/expert/<step>/`.


### Step solo

1. One at a time: A12 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A12.json`
2. One at a time: A08 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A08.json`
3. One at a time: A10 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A10.json`
4. One at a time: A11 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A11.json`
5. One at a time: A15 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A15.json`
6. One at a time: A07 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A07.json`
7. One at a time: A16 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A16.json`
8. One at a time: A06 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A06.json`
9. One at a time: A09 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A09.json`
10. One at a time: A14 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A14.json`
11. One at a time: A04 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A04.json`
12. One at a time: A05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A05.json`
13. One at a time: A01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A01.json`
14. One at a time: A17 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A17.json`
15. One at a time: A20 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A20.json`
16. One at a time: A03 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A03.json`
17. One at a time: A18 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A18.json`
18. One at a time: A13 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A13.json`
19. One at a time: A19 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A19.json`
20. One at a time: A02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/A02.json`
21. One at a time: B05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B05.json`
22. One at a time: B09 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B09.json`
23. One at a time: B10 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B10.json`
24. One at a time: B13 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B13.json`
25. One at a time: B15 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B15.json`
26. One at a time: B11 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B11.json`
27. One at a time: B07 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B07.json`
28. One at a time: B14 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B14.json`
29. One at a time: B12 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B12.json`
30. One at a time: B06 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B06.json`
31. One at a time: B16 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B16.json`
32. One at a time: B20 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B20.json`
33. One at a time: B19 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B19.json`
34. One at a time: B03 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B03.json`
35. One at a time: B08 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B08.json`
36. One at a time: B01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B01.json`
37. One at a time: B17 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B17.json`
38. One at a time: B18 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B18.json`
39. One at a time: B04 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B04.json`
40. One at a time: B02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo/B02.json`

### Step pass1

41. 5 at a time (pass1, batch 1): A14, A04, A12, A03, A02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/A-b1.json`
42. 5 at a time (pass1, batch 2): A01, A19, A06, A08, A11 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/A-b2.json`
43. 5 at a time (pass1, batch 3): A09, A18, A20, A13, A16 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/A-b3.json`
44. 5 at a time (pass1, batch 4): A17, A07, A10, A15, A05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/A-b4.json`
45. 5 at a time (pass1, batch 1): B02, B03, B06, B07, B17 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/B-b1.json`
46. 5 at a time (pass1, batch 2): B19, B16, B09, B10, B01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/B-b2.json`
47. 5 at a time (pass1, batch 3): B20, B15, B11, B18, B04 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/B-b3.json`
48. 5 at a time (pass1, batch 4): B14, B13, B12, B08, B05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1/B-b4.json`

### Step pass2

49. 5 at a time (pass2, batch 1): A10, A15, A03, A04, A09 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/A-b1.json`
50. 5 at a time (pass2, batch 2): A08, A20, A02, A07, A19 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/A-b2.json`
51. 5 at a time (pass2, batch 3): A11, A14, A05, A18, A01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/A-b3.json`
52. 5 at a time (pass2, batch 4): A13, A12, A16, A17, A06 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/A-b4.json`
53. 5 at a time (pass2, batch 1): B08, B14, B17, B11, B03 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/B-b1.json`
54. 5 at a time (pass2, batch 2): B18, B12, B19, B06, B10 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/B-b2.json`
55. 5 at a time (pass2, batch 3): B09, B04, B16, B13, B20 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/B-b3.json`
56. 5 at a time (pass2, batch 4): B01, B05, B15, B02, B07 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass2/B-b4.json`

### Step pass3

57. 5 at a time (pass3, batch 1): A16, A08, A04, A05, A20 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/A-b1.json`
58. 5 at a time (pass3, batch 2): A07, A13, A11, A01, A03 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/A-b2.json`
59. 5 at a time (pass3, batch 3): A19, A10, A15, A14, A18 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/A-b3.json`
60. 5 at a time (pass3, batch 4): A12, A06, A09, A02, A17 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/A-b4.json`
61. 5 at a time (pass3, batch 1): B11, B17, B18, B05, B13 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/B-b1.json`
62. 5 at a time (pass3, batch 2): B10, B20, B03, B15, B19 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/B-b2.json`
63. 5 at a time (pass3, batch 3): B04, B08, B01, B14, B06 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/B-b3.json`
64. 5 at a time (pass3, batch 4): B16, B09, B07, B12, B02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass3/B-b4.json`

### Step solo-repeat

65. One at a time: A05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/A05.json`
66. One at a time: A01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/A01.json`
67. One at a time: A07 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/A07.json`
68. One at a time: A15 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/A15.json`
69. One at a time: A06 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/A06.json`
70. One at a time: B02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/B02.json`
71. One at a time: B08 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/B08.json`
72. One at a time: B11 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/B11.json`
73. One at a time: B10 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/B10.json`
74. One at a time: B19 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/solo-repeat/B19.json`

### Step pass1-repeat

75. 5 at a time (pass1, batch 1): A14, A04, A12, A03, A02 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/A-b1.json`
76. 5 at a time (pass1, batch 2): A01, A19, A06, A08, A11 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/A-b2.json`
77. 5 at a time (pass1, batch 3): A09, A18, A20, A13, A16 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/A-b3.json`
78. 5 at a time (pass1, batch 4): A17, A07, A10, A15, A05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/A-b4.json`
79. 5 at a time (pass1, batch 1): B02, B03, B06, B07, B17 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/B-b1.json`
80. 5 at a time (pass1, batch 2): B19, B16, B09, B10, B01 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/B-b2.json`
81. 5 at a time (pass1, batch 3): B20, B15, B11, B18, B04 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/B-b3.json`
82. 5 at a time (pass1, batch 4): B14, B13, B12, B08, B05 -> `~/research/portfoliorank-experiments/grading-two-sets/expert/pass1-repeat/B-b4.json`
