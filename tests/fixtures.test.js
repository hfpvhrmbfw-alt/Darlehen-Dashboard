// Festgehaltene Ergebnisse des Rechenkerns (tests/fixtures/loan-cases.json). Dieselben Fälle sollen später in Swift-Tests laufen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, compare, repaymentPlan, validate, milestones } from '../src/loan.js';

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/loan-cases.json', import.meta.url), 'utf8'));
const close = (a, b, label) => {
  if (b === null || typeof b === 'string') return assert.equal(a, b, label);
  assert.ok(Math.abs(a - b) <= 1e-6, `${label}: ${a} statt ${b}`);
};

for (const c of cases) {
  test(`Fixture ${c.id}`, () => {
    const input = { ...DEFAULTS, ...c.input };
    const r = compare(input), p = repaymentPlan(input), e = c.expected;
    for (const k of ['finalWithout', 'finalWith', 'diff', 'yearsWithout', 'yearsWith', 'payment']) close(r[k], e[k], k);
    for (const k of ['count', 'first', 'last', 'total', 'debtEnd', 'taxTotal']) close(p[k], e.plan[k], `plan.${k}`);
    milestones(input, [200000, 500000, 1000000]).forEach((y, j) => close(y, e.milestones[j], `milestone ${j}`));
    assert.deepEqual(validate(input).map((v) => v.code), e.issues);
  });
}
