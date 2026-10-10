import { describe, expect, it } from 'vitest';
import { buildGateContext, checkBullet, checkSkillsOrder, checkSummary, extractNumbers, newNumbers, totalYears } from './index';

const now = new Date('2026-09-30T00:00:00Z');

const ctx = buildGateContext({
  now,
  roles: [
    {
      role_id: 'role_1',
      employer: 'Globex',
      title: 'Data Engineer',
      start: '2021-03',
      end: 'present',
      bullets: [
        { bullet_id: 'role_1.b_1', text: 'Built Kafka-based pipeline processing 2M events/day', claim_ids: ['c1', 'c2', 'c3'] },
        { bullet_id: 'role_1.b_2', text: 'Assisted with deploying services to k8s using Helm', claim_ids: ['c4', 'c5', 'c6'] },
      ],
    },
    {
      role_id: 'role_2',
      employer: 'Initech',
      title: 'Analyst',
      start: '2010-01',
      end: '2012-12',
      bullets: [{ bullet_id: 'role_2.b_1', text: 'Wrote SQL reports for finance', claim_ids: ['c7', 'c8'] }],
    },
  ],
  claims: [
    { claim_id: 'c1', type: 'responsibility', value: 'x', text: 'Built Kafka-based pipeline processing 2M events/day', role_id: 'role_1' },
    { claim_id: 'c2', type: 'tool', value: 'Apache Kafka', text: 'Built Kafka-based pipeline processing 2M events/day', role_id: 'role_1' },
    { claim_id: 'c3', type: 'metric', value: { number: 2e6, unit: '', raw: '2M' }, text: 'Built Kafka-based pipeline processing 2M events/day', role_id: 'role_1' },
    { claim_id: 'c4', type: 'responsibility', value: 'x', text: 'Assisted with deploying services to k8s using Helm', role_id: 'role_1' },
    { claim_id: 'c5', type: 'tool', value: 'Kubernetes', text: 'Assisted with deploying services to k8s using Helm', role_id: 'role_1' },
    { claim_id: 'c6', type: 'tool', value: 'Helm', text: 'Assisted with deploying services to k8s using Helm', role_id: 'role_1' },
    { claim_id: 'c7', type: 'responsibility', value: 'x', text: 'Wrote SQL reports for finance', role_id: 'role_2' },
    { claim_id: 'c8', type: 'tool', value: 'SQL', text: 'Wrote SQL reports for finance', role_id: 'role_2' },
    { claim_id: 'c9', type: 'skill', value: 'AWS', text: 'AWS' },
  ],
  skills: [
    { skill_id: 'sk_1', name: 'Kafka', evidence_level: 'demonstrated' },
    { skill_id: 'sk_2', name: 'AWS', evidence_level: 'listed_only' },
  ],
});

const bullet = (text: string, extra: Partial<Parameters<typeof checkBullet>[0]> = {}) =>
  checkBullet({ bullet_id: 'role_1.b_1', role_id: 'role_1', source_bullet_ids: ['role_1.b_1'], text, claim_ids: ['c1', 'c2', 'c3'], ...extra }, ctx);

describe('numbers', () => {
  it('normalizes 2M = 2,000,000 = 2 million', () => {
    expect(newNumbers('processing 2,000,000 events', ['2M events'])).toHaveLength(0);
    expect(newNumbers('processing 2 million events', ['2M events'])).toHaveLength(0);
    expect(newNumbers('cut costs 40%', ['cut costs'])).toHaveLength(1);
    expect(extractNumbers('3x faster, 35% cheaper, $1.2M saved').map((n) => n.kind)).toEqual(['multiplier', 'percent', 'currency']);
  });
  it('computes total years with overlaps merged', () => {
    expect(totalYears([{ start: '2020-01', end: '2021-12' }, { start: '2021-01', end: '2022-12' }], now)).toBe(3);
  });
});

describe('gates', () => {
  it('passes a legitimate rewrite that surfaces existing evidence', () => {
    const r = bullet('Built a Kafka-based streaming pipeline processing 2M events/day');
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('allows JD terminology for an existing claim (k8s → Kubernetes)', () => {
    const r = checkBullet(
      { bullet_id: 'role_1.b_2', role_id: 'role_1', source_bullet_ids: ['role_1.b_2'], text: 'Assisted with deploying services to Kubernetes using Helm', claim_ids: ['c4', 'c5', 'c6'] },
      ctx,
    );
    expect(r.violations).toEqual([]);
  });

  it('G2: rejects a new metric', () => {
    const r = bullet('Built Kafka pipeline processing 2M events/day, cutting costs 40%');
    expect(r.violations.map((v) => v.code)).toContain('new_number');
  });

  it('G3: rejects a new tool with no claim', () => {
    const r = bullet('Built Kafka-based pipeline on AWS processing 2M events/day');
    expect(r.violations.map((v) => v.code)).toContain('new_skill_or_tool');
  });

  it('G3: rejects a new organisation name', () => {
    const r = bullet('Built Kafka-based pipeline processing 2M events/day for Netflix');
    expect(r.violations.map((v) => v.code)).toContain('new_entity');
  });

  it('G5: rejects assisted → led', () => {
    const r = checkBullet(
      { bullet_id: 'role_1.b_2', role_id: 'role_1', source_bullet_ids: ['role_1.b_2'], text: 'Led deployment of services to Kubernetes using Helm', claim_ids: ['c4', 'c5', 'c6'] },
      ctx,
    );
    expect(r.violations.map((v) => v.code)).toContain('ownership_upgrade');
  });

  it('G6: rejects Kubernetes introduced into a 2012 role', () => {
    const r = checkBullet(
      { bullet_id: 'role_2.b_1', role_id: 'role_2', source_bullet_ids: ['role_2.b_1'], text: 'Wrote SQL reports for finance on Kubernetes', claim_ids: ['c7', 'c8', 'c5'] },
      ctx,
    );
    const codes = r.violations.map((v) => v.code);
    expect(codes).toContain('anachronism');
    expect(codes).toContain('cross_role_transplant');
  });

  it('G1: rejects cross-role transplant of claims', () => {
    const r = bullet('Built Kafka-based pipeline processing 2M events/day', { claim_ids: ['c1', 'c7'] });
    expect(r.violations.map((v) => v.code)).toContain('cross_role_transplant');
  });

  it('G4: listed-only skill promoted into a bullet is a soft violation', () => {
    const r = bullet('Built Kafka-based pipeline processing 2M events/day', { claim_ids: ['c1', 'c2', 'c3', 'c9'] });
    const v = r.violations.find((x) => x.code === 'listed_only_promoted');
    expect(v?.soft).toBe(true);
  });

  it('summary: rejects years inflation and allows supported years', () => {
    expect(checkSummary('Data engineer with 10 years of experience in Kafka', ['c2'], ctx, null).violations.map((v) => v.code)).toContain('years_inflation');
    // role_2 (2010–2012) + role_1 (2021-03 → 2026-09) ≈ 8.6 years
    expect(checkSummary('Data engineer with 8 years of experience in Kafka', ['c2'], ctx, null).violations).toEqual([]);
  });

  it('skills order may only reorder existing skills', () => {
    expect(checkSkillsOrder(['sk_2', 'sk_1'], ctx).ok).toBe(true);
    expect(checkSkillsOrder(['sk_1', 'sk_99'], ctx).ok).toBe(false);
  });
});
