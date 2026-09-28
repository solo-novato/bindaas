import type { ThreadSettings } from './types';
export function profileLabel(id: string | null | undefined) {
  return (
    (
      {
        ':read-only': 'Read only',
        ':workspace': 'Workspace',
        ':danger-full-access': 'Full access',
      } as Record<string, string>
    )[id ?? ''] ??
    id ??
    'Not reported'
  );
}
export const policyOptions = [
  {
    id: 'untrusted',
    label: 'Ask for untrusted commands',
    description:
      'Codex can run trusted read commands; other commands need your approval.',
  },
  {
    id: 'on-request',
    label: 'Ask when needed',
    description: 'Codex requests approval when it needs additional access.',
  },
  {
    id: 'never',
    label: 'Never ask',
    description:
      'Codex cannot request additional access. Its configured file and network limits still apply.',
  },
];
export function policyLabel(policy: unknown) {
  return (
    policyOptions.find((p) => p.id === policy)?.label ??
    (policy && typeof policy === 'object'
      ? 'Custom approval rules'
      : 'Not reported')
  );
}
export function accessDetails(settings: ThreadSettings | null) {
  const raw = settings?.sandbox;
  const s =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = String(s.type ?? '');
  const workspace = type === 'workspaceWrite' || type === 'workspace-write';
  const full = type === 'dangerFullAccess' || type === 'danger-full-access';
  const read = type === 'readOnly' || type === 'read-only';
  const network = s.networkAccess ?? s.network_access;
  const roots = s.writableRoots ?? s.writable_roots;
  return {
    label: settings?.permissionProfile?.id
      ? profileLabel(settings.permissionProfile.id)
      : full
        ? 'Full access'
        : workspace
          ? 'Workspace'
          : read
            ? 'Read only'
            : 'Not reported',
    network:
      full || network === true || network === 'enabled'
        ? 'Allowed'
        : network === false || network === 'restricted'
          ? 'Restricted'
          : 'Not reported',
    files: full
      ? 'All files accessible to Codex'
      : read
        ? 'Reading only; no file writes'
        : workspace
          ? 'Project and additional writable folders'
          : 'Not reported',
    roots: workspace
      ? [
          ...new Set([
            ...(settings?.cwd ? [settings.cwd] : []),
            ...(Array.isArray(roots)
              ? roots.filter((v): v is string => typeof v === 'string')
              : []),
          ]),
        ]
      : [],
    temporary:
      workspace &&
      ((s.excludeTmpdirEnvVar ?? s.exclude_tmpdir_env_var) === false ||
        (s.excludeSlashTmp ?? s.exclude_slash_tmp) === false),
  };
}
export function tokenNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : 'Not reported';
}
export function windowLabel(minutes: number | null) {
  if (!minutes) return 'Usage window';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/** Human label for a sandbox policy reported by Codex. */
export function permissionLabel(value: unknown): string {
  const type =
    typeof value === 'string' ? value : (value as { type?: string })?.type;
  return (
    (
      {
        workspaceWrite: 'Workspace permissions',
        'workspace-write': 'Workspace permissions',
        readOnly: 'Read-only permissions',
        'read-only': 'Read-only permissions',
        dangerFullAccess: 'Full access',
        'danger-full-access': 'Full access',
      } as Record<string, string>
    )[type ?? ''] ?? 'Thread permissions'
  );
}
