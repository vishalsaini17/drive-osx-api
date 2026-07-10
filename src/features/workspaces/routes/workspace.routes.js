import express from 'express';
import { authenticate } from '../../../middleware/auth.middleware.js';
import {
  addMember,
  createWorkspace,
  listMembers,
  listWorkspaces,
  switchWorkspace,
  updateSharingPolicy
} from '../controllers/workspace.controller.js';

const router = express.Router();

router.post('/', authenticate, createWorkspace);
router.get('/', authenticate, listWorkspaces);
router.post('/:workspaceId/members', authenticate, addMember);
router.get('/:workspaceId/members', authenticate, listMembers);
router.post('/:workspaceId/switch', authenticate, switchWorkspace);
router.put('/:workspaceId/sharing-policy', authenticate, updateSharingPolicy);

export default router;
