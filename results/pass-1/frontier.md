**Warning. The number of runs that ended without an answer is 6. They score 0. A run that failed for a reason outside the agent, such as a rate limit, is retried when the eval is run again. A run where the agent itself gave no answer is final.**

# Cost and correctness frontier

| Setup | Correctness | Unsupported claims | Cost per answer | On the frontier |
| --- | --- | --- | --- | --- |
| H0 | 69.3% | 7.4% | $0.0358 | no |
| H1 | 69.1% | 1.0% | $0.0521 | no |
| H5-0 | 77.9% | 1.3% | $0.0063 | yes |
| H5-1 | 77.3% | 0.4% | $0.0277 | no |
| S0 | 82.2% | 1.7% | $0.0435 | yes |
| S1 | 81.1% | 0.0% | $0.0619 | no |
| OM0 | 91.0% | 0.8% | $0.1018 | yes |
| OM1 | 91.4% | 0.0% | $0.1249 | yes |
| OX0 | 92.7% | 1.2% | $0.1495 | yes |
| OX1 | 92.7% | 0.0% | $0.1767 | no |

A setup is on the frontier when no other setup is both cheaper and more accurate. From cheapest to most expensive, the frontier is H5-0, S0, OM0, OM1, OX0.

## Headline setups

The most accurate setup is OX0, with a correctness of 92.7% at $0.1495 per answer. The cheapest accurate setup is OM0, with a correctness of 91.0% at $0.1018 per answer. OX0 costs 1.5 times as much per answer as OM0.

## The rule

The rule was fixed before any results existed. It is written down in `eval/rubric.md`.

1. The most accurate setup is the one with the highest correctness. A tie goes to the cheaper setup.
2. The cheapest accurate setup is the cheapest one whose correctness is within 2 percentage points of the most accurate setup and whose unsupported-claim rate is at most 1 percentage point higher.
3. If one setup is both, the second headline setup is the next cheapest setup on the frontier.
