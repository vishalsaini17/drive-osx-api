import { Router } from 'express';
import { authenticate } from '../../platform/authentication/authenticate.js';
import * as controller from './organizations.controller.js';

/**
 * Mounted twice: at /organizations (current) and /workspaces (legacy alias
 * used by the shipped client). Both serve the same handlers.
 */
export const organizationRoutes = Router();

organizationRoutes.use(authenticate());

organizationRoutes.post('/', controller.create);
organizationRoutes.get('/', controller.list);
organizationRoutes.get('/:organizationId', controller.get);
organizationRoutes.get('/:organizationId/storage', controller.storageSummary);

organizationRoutes.get('/:organizationId/members', controller.listMembers);
organizationRoutes.post('/:organizationId/members', controller.addMember);
organizationRoutes.patch('/:organizationId/members/:userId', controller.updateMemberRole);
organizationRoutes.delete('/:organizationId/members/:userId', controller.removeMember);

organizationRoutes.post('/:organizationId/switch', controller.switchOrganization);
organizationRoutes.put('/:organizationId/sharing-policy', controller.updateSharingPolicy);

organizationRoutes.get('/:organizationId/teams', controller.listTeams);
organizationRoutes.post('/:organizationId/teams', controller.createTeam);
organizationRoutes.get('/:organizationId/teams/:teamId/members', controller.listTeamMembers);
organizationRoutes.post('/:organizationId/teams/:teamId/members', controller.addTeamMember);
organizationRoutes.delete('/:organizationId/teams/:teamId/members/:userId', controller.removeTeamMember);
