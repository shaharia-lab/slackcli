import type { SlackClient } from './slack-client.ts';

// A workspace's custom profile-field ID (XfXXXXXXXX) mapped to its human label.
// These IDs are workspace-defined and can be renamed by an admin, so the map is
// a convenience layer resolved live from team.profile.get — never a constant.
export type FieldLabelMap = Record<string, string>;

// Fetch the workspace's custom-field definitions and build an ID -> label map.
// One team.profile.get call; cache the result and reuse it across many users.
export async function buildFieldLabelMap(client: SlackClient): Promise<FieldLabelMap> {
  const resp = await client.getTeamProfile();
  const fields = resp?.profile?.fields || [];
  const map: FieldLabelMap = {};
  for (const f of fields) {
    if (f?.id) map[f.id] = f.label || f.id;
  }
  return map;
}

// Replace opaque custom-field IDs in a user's profile.fields with their labels.
//
// LABELS ONLY. The value is passed through untouched, including `user`-typed
// fields (Manager, Direct Reports) whose values are Slack user IDs (U…). This
// helper deliberately does NOT resolve those IDs to names — that second hop
// (team.profile.get gives labels for free; id->name needs an extra users.info
// per referenced user) is a separate opt-in feature, tracked apart from #174.
//
// Returns a plain { label: value } object; an unknown ID keeps its raw key so
// nothing is silently dropped.
export function resolveProfileFields(
  user: any,
  labels: FieldLabelMap,
): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = user?.profile?.fields || {};
  for (const [id, entry] of Object.entries<any>(fields)) {
    const label = labels[id] || id;
    out[label] = entry?.value ?? '';
  }
  return out;
}
