# Eval results in detail

This file breaks the runs behind `summary.md` down further. It is written by `npm run eval -- report` from the files in `runs/` and `grades/`, with no model call.

## What the two checks did

Counts over all repeats. The verdicts are those on the draft, before any repair. A claim that is not supported starts one repair attempt. A claim marked partially supported is kept and does not start a repair.

| Setup | Claims in the drafts | Failed the quote check | Not supported, by the verifier model | Partially supported | Runs with a repair | Still not supported after the repair, so removed | Summaries rebuilt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | 333 | 29 | 2 | 56 | 26 | 11 | 49 |
| H5-1 | 685 | 7 | 1 | 50 | 8 | 0 | 14 |
| S1 | 549 | 4 | 1 | 57 | 5 | 0 | 18 |
| OM1 | 701 | 3 | 0 | 45 | 3 | 0 | 15 |
| OX1 | 748 | 8 | 0 | 52 | 8 | 0 | 21 |

## Pairs that share a draft

A verifier-on run checks the draft of its verifier-off twin. When the verifier changes nothing, the judge grades the same text twice. When it changes the answer, the last column is the mean change in that answer's correctness, verifier on minus verifier off.

| Pair | Same final answer | Of those, scored differently by the judge | Answer changed by the verifier | Mean change in correctness |
| --- | --- | --- | --- | --- |
| H0 and H1 | 117 | 2 | 59 | -5.2 points |
| H5-0 and H5-1 | 164 | 0 | 19 | -1.8 points |
| S0 and S1 | 159 | 2 | 23 | 0.0 points |
| OM0 and OM1 | 165 | 2 | 18 | -1.9 points |
| OX0 and OX1 | 156 | 0 | 27 | -9.6 points |

## Correctness by category

The mean over all repeats. The number of questions is in brackets. A category with 3 questions moves by 11 points when one run changes.

| Setup | single_page (18) | multi_page (11) | numbers (10) | false_premise (5) | not_covered (8) | personal_judgement (6) | ambiguous (3) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | 67% | 58% | 75% | 53% | 100% | 89% | 78% |
| H1 | 64% | 55% | 76% | 53% | 100% | 89% | 78% |
| H5-0 | 82% | 81% | 89% | 87% | 83% | 44% | 56% |
| H5-1 | 79% | 81% | 92% | 87% | 83% | 44% | 56% |
| S0 | 82% | 72% | 87% | 83% | 88% | 78% | 89% |
| S1 | 81% | 73% | 87% | 87% | 88% | 78% | 89% |
| OM0 | 87% | 88% | 98% | 100% | 100% | 100% | 67% |
| OM1 | 88% | 87% | 98% | 98% | 100% | 100% | 67% |
| OX0 | 93% | 93% | 98% | 100% | 96% | 100% | 89% |
| OX1 | 91% | 92% | 98% | 100% | 96% | 100% | 78% |

## Behaviour

Runs where the agent did what the question called for, over all repeats.

| Setup | Answered when it should | Declined when it should | Asked when it should |
| --- | --- | --- | --- |
| H0 | 109 of 132 | 40 of 42 | 7 of 9 |
| H1 | 109 of 132 | 40 of 42 | 7 of 9 |
| H5-0 | 131 of 132 | 28 of 42 | 5 of 9 |
| H5-1 | 131 of 132 | 28 of 42 | 5 of 9 |
| S0 | 132 of 132 | 35 of 42 | 8 of 9 |
| S1 | 132 of 132 | 35 of 42 | 8 of 9 |
| OM0 | 132 of 132 | 42 of 42 | 6 of 9 |
| OM1 | 132 of 132 | 42 of 42 | 6 of 9 |
| OX0 | 132 of 132 | 41 of 42 | 8 of 9 |
| OX1 | 132 of 132 | 41 of 42 | 7 of 9 |

## Missing points and retrieval

Expected points of the questions that call for an answer, over all repeats. Only verifier-off setups are listed, because a verifier-on setup shares their searches. The columns after the fourth split the missing points of runs that did not fail by how far the point's evidence passage got. The evidence passage is the one the question's drafter took the point from. It was never returned by a search, or it was in a search result but not opened, or the agent read it in full. For the passages never returned, one column counts those where another passage of the same page was returned or read, so the agent had the right page and not the right passage.

| Setup | Expected points | Missing | In runs with no answer | Passage never returned | Of those, same page was returned | In a search result only | Read in full |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | 354 | 123 | 19 | 72 | 55 | 11 | 21 |
| H5-0 | 354 | 52 | 0 | 40 | 29 | 0 | 12 |
| S0 | 354 | 63 | 0 | 53 | 34 | 5 | 5 |
| OM0 | 354 | 32 | 0 | 28 | 11 | 4 | 0 |
| OX0 | 354 | 20 | 0 | 16 | 4 | 1 | 3 |

## The hardest questions

The 12 questions with the lowest mean correctness over all setups and repeats. 18 of 61 questions scored 100% in every run.

| Question | Category | Mean | H0 | H1 | H5-0 | H5-1 | S0 | S1 | OM0 | OM1 | OX0 | OX1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q044 | single_page | 27% | 0% | 0% | 33% | 33% | 0% | 0% | 33% | 33% | 67% | 67% |
| q028 | single_page | 42% | 22% | 22% | 67% | 67% | 56% | 56% | 33% | 33% | 33% | 33% |
| q019 | ambiguous | 43% | 33% | 33% | 67% | 67% | 67% | 67% | 0% | 0% | 67% | 33% |
| q008 | single_page | 47% | 0% | 0% | 0% | 0% | 33% | 33% | 100% | 100% | 100% | 100% |
| q030 | multi_page | 50% | 56% | 44% | 56% | 56% | 33% | 33% | 44% | 44% | 67% | 67% |
| q061 | multi_page | 51% | 25% | 33% | 50% | 50% | 17% | 17% | 75% | 67% | 92% | 83% |
| q012 | not_covered | 53% | 100% | 100% | 0% | 0% | 0% | 0% | 100% | 100% | 67% | 67% |
| q018 | multi_page | 60% | 67% | 67% | 33% | 33% | 44% | 44% | 78% | 78% | 78% | 78% |
| q023 | numbers | 60% | 0% | 0% | 33% | 33% | 67% | 67% | 100% | 100% | 100% | 100% |
| q033 | false_premise | 62% | 17% | 17% | 33% | 33% | 50% | 67% | 100% | 100% | 100% | 100% |
| q058 | personal_judgement | 67% | 67% | 67% | 0% | 0% | 67% | 67% | 100% | 100% | 100% | 100% |
| q055 | personal_judgement | 67% | 100% | 100% | 0% | 0% | 33% | 33% | 100% | 100% | 100% | 100% |

## Runs with no answer

A verifier-on setup shares the draft of its twin, so each failed draft shows twice.

| Setup | Repeat | Question | Reason |
| --- | --- | --- | --- |
| H0 | 1 | q034 | error_max_turns |
| H0 | 1 | q050 | error_max_turns |
| H0 | 2 | q009 | error_max_turns |
| H0 | 2 | q023 | error_max_turns |
| H0 | 2 | q038 | error_max_turns |
| H0 | 3 | q035 | error_max_turns |
| H0 | 3 | q044 | error_max_turns |
| H1 | 1 | q034 | error_max_turns |
| H1 | 1 | q050 | error_max_turns |
| H1 | 2 | q009 | error_max_turns |
| H1 | 2 | q023 | error_max_turns |
| H1 | 2 | q038 | error_max_turns |
| H1 | 3 | q035 | error_max_turns |
| H1 | 3 | q044 | error_max_turns |
| S0 | 1 | q055 | error_max_structured_output_retries |
| S1 | 1 | q055 | error_max_structured_output_retries |

## Second opinions on the judge

Other model reviewers labelled the 45 sampled decisions of the judge audit. They saw what the labelling page shows and not the judge's labels. A reviewer is a model too, so this is a weaker check than a person's labels, and no person has labelled the sample. The labels and each reviewer's reasons are in `eval/judge-audit-reviews.json`.

| Reviewer | Model | Same label as the judge | Claims | Answers |
| --- | --- | --- | --- | --- |
| opus | claude-opus-5-5 | 43 of 45 | 29 of 30 | 14 of 15 |
| codex | gpt-6-astra | 41 of 45 | 29 of 30 | 12 of 15 |

The reviewers gave each other the same label on 41 of 45 items. The judge and every reviewer gave the same label on 40 of 45.

The items where the labels differ. The label of an answer is the number of expected points it states.

| Item | Kind | Question | Setup | Judge | opus | codex |
| --- | --- | --- | --- | --- | --- | --- |
| c03 | claim | q024 | H5-0 | supported | supported | partially_supported |
| c10 | claim | q025 | H5-0 | partially_supported | supported | partially_supported |
| a02 | answer | q009 | H5-1 | 4 | 4 | 3 |
| a06 | answer | q061 | OX1 | 3 | 2 | 2 |
| a08 | answer | q034 | H5-0 | 2 | 2 | 0 |
