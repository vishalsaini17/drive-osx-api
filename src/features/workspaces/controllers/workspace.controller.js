import { asyncHandler } from '../../../shared/common/asyncHandler.js';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto.js';
import { validateCreateWorkspaceInput } from '../validators/workspace.validator.js';
import { WorkspaceService } from '../services/workspace.service.js';

const workspaceService = new WorkspaceService();

export const createWorkspace = asyncHandler(async (req, res) => {
  const dto = new CreateWorkspaceDto(req.body);
  validateCreateWorkspaceInput(dto);

  const workspace = await workspaceService.createWorkspace(req.user.id, dto);
  res.status(201).json({ message: 'Workspace created successfully', workspace });
});

export const listWorkspaces = asyncHandler(async (req, res) => {
  const workspaces = await workspaceService.listWorkspaces(req.user.id);
  res.json({ workspaces });
});

export const addMember = asyncHandler(async (req, res) => {
  const result = await workspaceService.addMember(req.user.id, req.params.workspaceId, req.body);
  res.status(201).json({ message: 'Member added successfully', result });
});

export const switchWorkspace = asyncHandler(async (req, res) => {
  const result = await workspaceService.switchWorkspace(req.user.id, req.params.workspaceId);
  res.json(result);
});

export const updateSharingPolicy = asyncHandler(async (req, res) => {
  const workspace = await workspaceService.updateSharingPolicy(req.user.id, req.params.workspaceId, req.body);
  res.json({ message: 'Sharing policy updated', workspace });
});

export const listMembers = asyncHandler(async (req, res) => {
  const members = await workspaceService.listMembers(req.user.id, req.params.workspaceId);
  res.json({ members });
});
