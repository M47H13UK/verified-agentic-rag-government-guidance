**Warning. The number of runs that ended without an answer is 16. They score 0. A run that failed for a reason outside the agent, such as a rate limit, is retried when the eval is run again. A run where the agent itself gave no answer is final.**

# Eval results

Generated on 2026-10-08. The gold set has 61 questions and 61 of them have been checked by hand. The judge model is `claude-opus-5-5`. The verifier model is `claude-sonnet-5-5`.

| Setup | Model | Effort | Verifier | Questions | Repeats | Correctness | Unsupported claims | Behaviour accuracy | Retrieval hit rate | Cost per answer | Latency p50 | Latency p95 | Claims shown | Errors | Dropped by quote check | Dropped by verifier | Repairs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | `claude-haiku-4-5` | default | off | 61 | 3 | 72.6% (69.3% to 76.3%) | 9.6% (7.4% to 13.2%) | 85.2% | 85.3% | $0.0360 | 20.6 s | 43.9 s | 333 | 7 | 0 | 0 | 0 |
| H1 | `claude-haiku-4-5` | default | on | 61 | 3 | 71.3% (68.0% to 76.9%) | 0.6% (0.0% to 1.0%) | 85.2% | 85.3% | $0.0547 | 26.4 s | 79.6 s | 325 | 7 | 29 | 2 | 26 |
| H5-0 | `claude-haiku-5-5` | default | off | 61 | 3 | 78.4% (76.8% to 80.6%) | 1.3% (0.4% to 2.2%) | 89.6% | 90.4% | $0.0062 | 18.8 s | 30.5 s | 685 | 0 | 0 | 0 | 0 |
| H5-1 | `claude-haiku-5-5` | default | on | 61 | 3 | 78.2% (76.2% to 81.1%) | 0.3% (0.0% to 0.4%) | 89.6% | 90.4% | $0.0280 | 24.1 s | 45.4 s | 684 | 0 | 7 | 1 | 8 |
| S0 | `claude-sonnet-5-5` | default | off | 61 | 3 | 81.8% (78.6% to 84.7%) | 0.7% (0.0% to 1.7%) | 95.6% | 82.1% | $0.0462 | 12.1 s | 33.1 s | 549 | 1 | 0 | 0 | 0 |
| S1 | `claude-sonnet-5-5` | default | on | 61 | 3 | 81.8% (80.5% to 83.9%) | 0.0% (0.0% to 0.0%) | 95.6% | 82.1% | $0.0644 | 17.9 s | 43.7 s | 547 | 1 | 4 | 1 | 5 |
| OM0 | `claude-opus-5-5` | medium | off | 61 | 3 | 92.0% (90.3% to 94.7%) | 0.4% (0.0% to 0.8%) | 98.4% | 86.5% | $0.0921 | 15.2 s | 28.0 s | 701 | 0 | 0 | 0 | 0 |
| OM1 | `claude-opus-5-5` | medium | on | 61 | 3 | 91.9% (90.3% to 94.1%) | 0.0% (0.0% to 0.0%) | 98.4% | 86.5% | $0.1137 | 20.0 s | 37.1 s | 701 | 0 | 3 | 0 | 3 |
| OX0 | `claude-opus-5-5` | xhigh | off | 61 | 3 | 95.3% (92.7% to 97.5%) | 1.1% (0.8% to 1.2%) | 98.9% | 89.7% | $0.1454 | 25.4 s | 54.4 s | 748 | 0 | 0 | 0 | 0 |
| OX1 | `claude-opus-5-5` | xhigh | on | 61 | 3 | 93.9% (92.7% to 94.5%) | 0.0% (0.0% to 0.0%) | 98.4% | 89.7% | $0.1725 | 30.8 s | 64.6 s | 744 | 0 | 8 | 0 | 8 |

With more than one repeat, correctness and unsupported claims show the mean, then the lowest and the highest repeat in brackets. Every metric is defined in `eval/rubric.md`.

The runs and the judge cost $178.11 in total at list prices. A draft shared by a verifier-off setup and its verifier-on twin is counted in both, so the amount spent is lower.

How often the judge agrees with a person is reported separately. Label `eval/judge-audit.csv`, then run `npm run eval -- audit-score`.
