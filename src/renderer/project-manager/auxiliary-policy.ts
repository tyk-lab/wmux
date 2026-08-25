/** Auxiliary writes are limited to durable documentation and classified project facts. */
export function projectAuxiliaryWritablePathAllowed(value: string): boolean {
  const path = value.trim().replace(/\\/gu, '/');
  if (!path
    || path.startsWith('/')
    || /^[A-Za-z]:/u.test(path)
    || path.startsWith('//')
    || path.split('/').some((segment) => !segment || segment === '..')) return false;
  return /^(?:README(?:\.[^/]+)?\.md|CHANGELOG\.md|docs\/.+\.(?:md|txt|json|ya?ml)|\.project-handbook\/.+\.md|\.project-plans\/(?:PROGRESS\.md|(?:plans|debug|archive)\/.+)|runs\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\/.+)$/iu.test(path);
}
