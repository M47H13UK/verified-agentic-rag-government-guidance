**Warning. The number of runs that ended without an answer is 6. They score 0. A run that failed for a reason outside the agent, such as a rate limit, is retried when the eval is run again. A run where the agent itself gave no answer is final.**

# Eval results

Generated on 2026-10-08. The gold set has 61 questions and 61 of them have been checked by hand. The judge model is `claude-opus-5-5`. The verifier model is `claude-sonnet-5-5`.

| Setup | Model | Effort | Verifier | Questions | Repeats | Correctness | Unsupported claims | Behaviour accuracy | Retrieval hit rate | Cost per answer | Latency p50 | Latency p95 | Claims shown | Errors | Dropped by quote check | Dropped by verifier | Repairs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | `claude-haiku-4-5` | default | off | 61 | 1 | 69.3% | 7.4% | 82.0% | 86.5% | $0.0358 | 25.2 s | 45.7 s | 108 | 2 | 0 | 0 | 0 |
| H1 | `claude-haiku-4-5` | default | on | 61 | 1 | 69.1% | 1.0% | 82.0% | 86.5% | $0.0521 | 31.5 s | 87.5 s | 105 | 2 | 6 | 1 | 6 |
| H5-0 | `claude-haiku-5-5` | default | off | 61 | 1 | 77.9% | 1.3% | 90.2% | 92.3% | $0.0063 | 19.0 s | 35.1 s | 229 | 0 | 0 | 0 | 0 |
| H5-1 | `claude-haiku-5-5` | default | on | 61 | 1 | 77.3% | 0.4% | 90.2% | 92.3% | $0.0277 | 24.9 s | 45.5 s | 229 | 0 | 2 | 0 | 2 |
| S0 | `claude-sonnet-5-5` | default | off | 61 | 1 | 82.2% | 1.7% | 96.7% | 80.8% | $0.0435 | 14.6 s | 33.1 s | 177 | 1 | 0 | 0 | 0 |
| S1 | `claude-sonnet-5-5` | default | on | 61 | 1 | 81.1% | 0.0% | 96.7% | 80.8% | $0.0619 | 19.7 s | 41.0 s | 176 | 1 | 3 | 0 | 3 |
| OM0 | `claude-opus-5-5` | medium | off | 61 | 1 | 91.0% | 0.8% | 98.4% | 84.6% | $0.1018 | 15.2 s | 31.3 s | 239 | 0 | 0 | 0 | 0 |
| OM1 | `claude-opus-5-5` | medium | on | 61 | 1 | 91.4% | 0.0% | 98.4% | 84.6% | $0.1249 | 20.3 s | 41.1 s | 239 | 0 | 2 | 0 | 2 |
| OX0 | `claude-opus-5-5` | xhigh | off | 61 | 1 | 92.7% | 1.2% | 98.4% | 92.3% | $0.1495 | 25.7 s | 49.6 s | 253 | 0 | 0 | 0 | 0 |
| OX1 | `claude-opus-5-5` | xhigh | on | 61 | 1 | 92.7% | 0.0% | 98.4% | 92.3% | $0.1767 | 31.8 s | 67.1 s | 252 | 0 | 3 | 0 | 3 |

With more than one repeat, correctness and unsupported claims show the mean, then the lowest and the highest repeat in brackets. Every metric is defined in `eval/rubric.md`.

The runs and the judge cost $60.53 in total at list prices. A draft shared by a verifier-off setup and its verifier-on twin is counted in both, so the amount spent is lower.

How often the judge agrees with a person is reported separately. Label `eval/judge-audit.csv`, then run `npm run eval -- audit-score`.
