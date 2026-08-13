import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireOrganization, requireUser } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseBody, parseParams } from '../../platform/http/validate.js';
import { ORGANIZATION_ROLES } from '../../platform/authorization/roles.js';
import * as service from './organizations.service.js';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name is required').max(80),
  type: z.enum(['personal', 'organization']).default('organization'),
});

const addMemberSchema = z.object({
  usernameOrEmail: z.string().trim().min(1, 'Enter a username or email address'),
  role: z.enum(ORGANIZATION_ROLES).optional(),
});

const roleSchema = z.object({ role: z.enum(ORGANIZATION_ROLES) });

const sharingPolicySchema = z.object({
  allowExternalSharing: z.boolean().optional(),
  mode: z.enum(['allow', 'warn', 'restrict', 'notify_specific']).optional(),
  warningMessage: z.string().max(500).optional(),
  notifyUserIds: z.array(z.string().uuid()).optional(),
});

const teamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(80),
  description: z.string().trim().max(500).optional(),
});

const teamMemberSchema = z.object({
  userId: z.string().uuid('A valid user id is required'),
  role: z.enum(['lead', 'member']).default('member'),
});

const organizationParams = z.object({ organizationId: z.string().uuid('Invalid workspace id') });
const memberParams = organizationParams.extend({ userId: z.string().uuid('Invalid user id') });
const teamParams = organizationParams.extend({ teamId: z.string().uuid('Invalid team id') });
const teamMemberParams = teamParams.extend({ userId: z.string().uuid('Invalid user id') });

export const create = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const body = parseBody(createSchema, req);
  const organization = await service.createOrganization(user.id, body);
  // `workspace` is the legacy field name; both are returned during migration.
  res.status(201).json({ message: 'Workspace created successfully', organization, workspace: organization });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const memberships = await service.listForUser(user.id);

  res.json({
    organizations: memberships.map((entry) => ({ ...entry.organization, role: entry.role, status: entry.status })),
    workspaces: memberships.map((entry) => ({
      workspace: entry.organization,
      role: entry.role,
      status: entry.status,
    })),
  });
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const organization = await service.getOrganization(user.id, organizationId);
  res.json({ organization, workspace: organization });
});

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const members = await service.listMembers(user.id, organizationId);
  res.json({ members });
});

export const addMember = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const body = parseBody(addMemberSchema, req);
  const member = await service.addMember(user.id, organizationId, body);
  res.status(201).json({ message: 'Member added successfully', member });
});

export const updateMemberRole = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId, userId } = parseParams(memberParams, req);
  const { role } = parseBody(roleSchema, req);
  const member = await service.updateMemberRole(user.id, organizationId, userId, role);
  res.json({ message: 'Member role updated', member });
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId, userId } = parseParams(memberParams, req);
  await service.removeMember(user.id, organizationId, userId);
  res.json({ message: 'Member removed from workspace' });
});

export const switchOrganization = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const organization = await service.switchOrganization(user.id, organizationId);
  res.json({
    message: 'Workspace switched successfully',
    organization,
    workspace: organization,
    // The access token embeds the previous workspace; the client must refresh.
    requiresTokenRefresh: true,
  });
});

export const updateSharingPolicy = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const body = parseBody(sharingPolicySchema, req);
  const organization = await service.updateSharingPolicy(user.id, organizationId, body);
  res.json({ message: 'Sharing policy updated', organization, workspace: organization });
});

export const storageSummary = asyncHandler(async (req: Request, res: Response) => {
  const { user, organizationId } = requireOrganization(req);
  const summary = await service.getStorageSummary(user.id, organizationId);
  res.json({ storage: summary });
});

export const createTeam = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const body = parseBody(teamSchema, req);
  const team = await service.createTeam(user.id, organizationId, body);
  res.status(201).json({ message: 'Team created', team });
});

export const listTeams = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId } = parseParams(organizationParams, req);
  const teams = await service.listTeams(user.id, organizationId);
  res.json({ teams });
});

export const addTeamMember = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId, teamId } = parseParams(teamParams, req);
  const body = parseBody(teamMemberSchema, req);
  await service.addTeamMember(user.id, organizationId, teamId, body.userId, body.role);
  res.status(201).json({ message: 'Team member added' });
});

export const removeTeamMember = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId, teamId, userId } = parseParams(teamMemberParams, req);
  await service.removeTeamMember(user.id, organizationId, teamId, userId);
  res.json({ message: 'Team member removed' });
});

export const listTeamMembers = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { organizationId, teamId } = parseParams(teamParams, req);
  const members = await service.listTeamMembers(user.id, organizationId, teamId);
  res.json({ members });
});
