export function validateCreateWorkspaceInput({ name, type }) {
  if (!name) {
    throw new Error('Workspace name is required');
  }

  if (!type) {
    throw new Error('Workspace type is required');
  }

  if (!['personal', 'organization'].includes(type)) {
    throw new Error('Workspace type must be personal or organization');
  }
}
