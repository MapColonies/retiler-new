import type { GateCheck, GateResult, GateStatus } from './types.mts';

const STATUS_ICON: Record<GateStatus, string> = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', 'not-run': 'NOT RUN' };

export const check = (name: string, status: GateStatus, detail: string, evidence?: unknown): GateCheck => ({
  name,
  status,
  detail,
  ...(evidence === undefined ? {} : { evidence }),
});

/**
 * A gate is only as good as its weakest check. `blocked` outranks `not-run` so
 * a gate that could not run because an earlier one failed is not confused with
 * one whose checks simply were not attempted.
 */
export const rollUp = (checks: GateCheck[]): GateStatus => {
  if (checks.some((entry) => entry.status === 'fail')) {
    return 'fail';
  }
  if (checks.some((entry) => entry.status === 'blocked')) {
    return 'blocked';
  }
  if (checks.length === 0 || checks.every((entry) => entry.status === 'not-run')) {
    return 'not-run';
  }
  return 'pass';
};

const formatEvidence = (evidence: unknown): string => {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  return text.length > 1500 ? `${text.slice(0, 1500)}\n... truncated` : text;
};

export const renderMarkdown = (results: GateResult[], context: Record<string, unknown>): string => {
  const lines: string[] = [];

  lines.push('# Turso GeoPackage feasibility -- gate results', '');
  lines.push('## Environment', '');
  for (const [key, value] of Object.entries(context)) {
    lines.push(`- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  lines.push('', '## Verdict summary', '', '| Gate | Title | Status | Summary |', '| --- | --- | --- | --- |');
  for (const result of results) {
    lines.push(`| ${result.id} | ${result.title} | **${STATUS_ICON[result.status]}** | ${result.summary} |`);
  }

  for (const result of results) {
    lines.push('', `## Gate ${result.id}: ${result.title}`, '');
    lines.push(`**${STATUS_ICON[result.status]}** -- ${result.summary}`, '');
    lines.push(`Ran in ${(result.durationMs / 1000).toFixed(1)}s.`, '');

    if (result.checks.length > 0) {
      lines.push('| Check | Status | Detail |', '| --- | --- | --- |');
      for (const entry of result.checks) {
        lines.push(`| ${entry.name} | ${STATUS_ICON[entry.status]} | ${entry.detail.replace(/\|/gu, '\\|')} |`);
      }
    }

    const withEvidence = result.checks.filter((entry) => entry.evidence !== undefined);
    if (withEvidence.length > 0) {
      lines.push('', '<details><summary>Evidence</summary>', '');
      for (const entry of withEvidence) {
        lines.push(`**${entry.name}**`, '', '```', formatEvidence(entry.evidence), '```', '');
      }
      lines.push('</details>');
    }

    if (result.measurements !== undefined) {
      lines.push(
        '',
        '<details><summary>Measurements</summary>',
        '',
        '```json',
        JSON.stringify(result.measurements, null, 2),
        '```',
        '',
        '</details>'
      );
    }
  }

  return `${lines.join('\n')}\n`;
};
