// Example questions for the Ask view, grouped by the kind of person who would ask them.
// A click copies the question into the box. It does not send it.

export type ExampleGroup = {
  persona: string;
  questions: string[];
};

export const EXAMPLE_GROUPS: ExampleGroup[] = [
  {
    persona: "Final-year student who wants to stay",
    questions: [
      "How long does a Graduate visa last and how much does it cost?",
      "When can I apply for a Graduate visa?",
      "Which courses make me eligible for a Graduate visa?",
    ],
  },
  {
    persona: "Graduate with a job offer",
    questions: [
      "Can I switch from a Graduate visa to a Skilled Worker visa?",
      "What salary do I need for a Skilled Worker visa?",
    ],
  },
  {
    persona: "Student working during studies",
    questions: [
      "How many hours can I work in term time on a Student visa?",
      "Can I be self-employed on a Student visa?",
    ],
  },
  {
    persona: "Student with a partner or child",
    questions: [
      "Can my partner and children stay with me on a Graduate visa?",
      "What must my partner prove to apply as my dependant?",
    ],
  },
  {
    persona: "Practical questions",
    questions: [
      "What documents do I need to apply for a Graduate visa?",
      "How long does a Graduate visa decision take?",
      "Can I travel abroad while I wait for a Graduate visa decision?",
    ],
  },
  {
    persona: "Out of scope",
    questions: [
      "Will my Graduate visa application be approved?",
      "Which university should I choose for my master's degree?",
    ],
  },
];
