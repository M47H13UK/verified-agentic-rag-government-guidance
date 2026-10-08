**Warning. The number of runs that ended without an answer is 16. They score 0. A run that failed for a reason outside the agent, such as a rate limit, is retried when the eval is run again. A run where the agent itself gave no answer is final.**

# Cost and correctness frontier

| Setup | Correctness | Unsupported claims | Cost per answer | On the frontier |
| --- | --- | --- | --- | --- |
| H0 | 72.6% | 9.6% | $0.0360 | no |
| H1 | 71.3% | 0.6% | $0.0547 | no |
| H5-0 | 78.4% | 1.3% | $0.0062 | yes |
| H5-1 | 78.2% | 0.3% | $0.0280 | no |
| S0 | 81.8% | 0.7% | $0.0462 | yes |
| S1 | 81.8% | 0.0% | $0.0644 | no |
| OM0 | 92.0% | 0.4% | $0.0921 | yes |
| OM1 | 91.9% | 0.0% | $0.1137 | no |
| OX0 | 95.3% | 1.1% | $0.1454 | yes |
| OX1 | 93.9% | 0.0% | $0.1725 | no |

A setup is on the frontier when no other setup is both cheaper and more accurate. From cheapest to most expensive, the frontier is H5-0, S0, OM0, OX0.

## Headline setups

The most accurate setup is OX0, with a correctness of 95.3% at $0.1454 per answer. It is also the cheapest accurate setup. By the rule, the second headline setup is the next cheapest one on the frontier, which is OM0, with a correctness of 92.0% at $0.0921 per answer. OX0 costs 1.6 times as much per answer as OM0.

## The rule

The rule was fixed before any results existed. It is written down in `eval/rubric.md`.

1. The most accurate setup is the one with the highest correctness. A tie goes to the cheaper setup.
2. The cheapest accurate setup is the cheapest one whose correctness is within 2 percentage points of the most accurate setup and whose unsupported-claim rate is at most 1 percentage point higher.
3. If one setup is both, the second headline setup is the next cheapest setup on the frontier.
